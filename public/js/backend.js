// All data access for the app: Supabase Auth, database (RLS + RPC functions), Storage and Edge Functions.
import { MAX_UPLOAD_MB, SUPABASE_KEY, SUPABASE_URL } from './config.js';
import { CATEGORIES, NO_COVER, STATUS, addDays, coversOn, fmtDate, roleLabel, roleNeedsCoverage, scheduleText, setSchoolRoles, todayStr, weekdays } from './lib.js';
import { buildXlsx, xDate, xDateTime } from './xlsx.js';
import { zip } from './zip.js';

export const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'lah-auth' },
});

const BUCKET = 'excuses';

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

function unauthorized() {
  window.dispatchEvent(new CustomEvent('lah:unauthorized'));
  return new ApiError('Tu sesión expiró. Vuelve a iniciar sesión.', 401);
}

/** Turns Supabase errors into short Spanish messages. Messages raised by our SQL functions are already Spanish. */
function toApiError(error) {
  if (!error) return new ApiError('Ocurrió un error. Inténtalo de nuevo.');
  const msg = String(error.message || '');
  if (error.hint === 'unauthorized' || /JWT|jwt expired|invalid claim|not authenticated/i.test(msg)) return unauthorized();
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(msg)) {
    return new ApiError('Sin conexión. Revisa tu internet e inténtalo de nuevo.');
  }
  if (/permission denied|violates row-level security/i.test(msg)) {
    return new ApiError('No tienes permiso para realizar esta acción.', 403);
  }
  if (error.code === 'P0001' || /[áéíóúñ¿¡]/i.test(msg)) return new ApiError(msg, 400);
  console.warn(error);
  return new ApiError('Ocurrió un error. Inténtalo de nuevo.');
}

async function run(query) {
  const { data, error, count } = await query;
  if (error) throw toApiError(error);
  return count !== undefined && count !== null && data === null ? count : data;
}

const rpc = (name, args) => run(sb.rpc(name, args));

/** Reads every row of a query in pages (the API returns at most 1000 at a time). Keep the query ordered. */
async function fetchAll(makeQuery) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const page = await run(makeQuery().range(from, from + 999));
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

/** Runs `.in(column, ids)` in chunks so the request URL stays short. */
async function fetchByIds(table, column, ids, select = '*') {
  const rows = [];
  for (let i = 0; i < ids.length; i += 150) {
    rows.push(...(await run(sb.from(table).select(select).in(column, ids.slice(i, i + 150)).order('id'))));
  }
  return rows;
}

async function callFunction(name, body, { auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json', apikey: SUPABASE_KEY };
  if (auth) {
    const { data } = await sb.auth.getSession();
    if (!data.session) throw unauthorized();
    headers.Authorization = `Bearer ${data.session.access_token}`;
  }
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch {
    throw new ApiError('Sin conexión. Revisa tu internet e inténtalo de nuevo.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && auth) throw unauthorized();
    throw new ApiError(data?.error || 'Ocurrió un error. Inténtalo de nuevo.', res.status);
  }
  return data;
}

// ---- Sesión ----------------------------------------------------------------

/** Internal login email for "school code + username" (the Edge Functions compute the same value). */
export async function authEmail(code, username) {
  const bytes = new TextEncoder().encode(`${code.trim().toUpperCase()}|${username.trim().toLowerCase()}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
  return `u${hex}@users.leap-hub.local`;
}

// How long this device took to open the app, sent once with the first request (it shows in Supabase's request log):
// milliseconds until the page arrived and until every file of the app loaded, whether the service worker served it,
// and whether it was opened as an installed app.
let startSent = false;
function startInfo() {
  if (startSent) return null;
  startSent = true;
  const nav = window.performance.getEntriesByType?.('navigation')?.[0];
  const installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ms = (n) => Math.round(n || 0);
  const sw = navigator.serviceWorker?.controller ? 1 : 0;
  return `hallway-web page=${ms(nav?.responseEnd)} start=${ms(window.performance.now())} sw=${sw} app=${installed ? 1 : 0}`;
}

export async function getMe() {
  const info = startInfo();
  const { data } = await sb.auth.getSession();
  if (!data.session) return null;
  try {
    const me = await run(info ? sb.rpc('me').setHeader('X-Client-Info', info) : sb.rpc('me'));
    setSchoolRoles(me?.roles);
    return me;
  } catch (err) {
    if (err.status === 401) return null;
    throw err;
  }
}

export async function signIn(schoolCode, username, password) {
  let code = String(schoolCode || '').trim().toUpperCase();
  const user = String(username || '').trim();
  if (!code || !user || !password) throw new ApiError('Completa todos los campos.');
  let { error } = await sb.auth.signInWithPassword({ email: await authEmail(code, user), password });
  if (error?.status === 400) {
    // The school may have changed its code: an old code (or an old link) still works.
    const current = await rpc('current_school_code', { p_code: code }).catch(() => null);
    if (current && current !== code) {
      code = current;
      ({ error } = await sb.auth.signInWithPassword({ email: await authEmail(code, user), password }));
    }
  }
  if (error) {
    if (error.code === 'user_banned') throw new ApiError('Tu cuenta está desactivada. Habla con la dirección.');
    if (error.status === 429) throw new ApiError('Demasiados intentos. Espera unos minutos e inténtalo de nuevo.');
    if (error.status === 400) throw new ApiError('Código de escuela, usuario o contraseña incorrectos.');
    throw toApiError(error);
  }
  const me = await getMe();
  if (!me) {
    await sb.auth.signOut({ scope: 'local' });
    throw new ApiError('Esta cuenta o escuela no está activa. Habla con la dirección.');
  }
  rpc('touch_login').catch(() => {});
  return me;
}

/** Icon of the school with this code (current or old), for the login screen. Null if unknown. */
export const schoolBranding = (code) => rpc('school_branding', { p_code: code }).catch(() => null);

/** Tells the school's administration someone forgot their password. Never reveals if the account exists. */
export const requestPasswordHelp = (schoolCode, username) =>
  rpc('request_password_help', { p_school_code: schoolCode, p_username: username });

export async function signOut() {
  await sb.auth.signOut({ scope: 'local' }).catch(() => {});
}

export async function changePassword(currentPassword, newPassword) {
  const { data } = await sb.auth.getUser();
  if (!data.user) throw unauthorized();
  const { error: loginError } = await sb.auth.signInWithPassword({ email: data.user.email, password: currentPassword });
  if (loginError) throw new ApiError('La contraseña actual no es correcta.');
  const { error } = await sb.auth.updateUser({ password: newPassword });
  if (error) {
    if (error.code === 'same_password') throw new ApiError('La nueva contraseña debe ser diferente.');
    if (error.code === 'weak_password') throw new ApiError('Esa contraseña es muy débil. Elige otra.');
    throw toApiError(error);
  }
  await rpc('password_changed');
  // Close the session on other devices.
  sb.auth.signOut({ scope: 'others' }).catch(() => {});
}

export const updateMyContact = (email, phone) => rpc('update_my_contact', { p_email: email || null, p_phone: phone || null });
/** The room where I usually am (empty = none). Returns the saved value. */
export const setMyRoom = (room) => rpc('set_my_room', { p_room: room || null });

// ---- Ausencias -------------------------------------------------------------

export const myAbsences = (userId) =>
  run(
    sb
      .from('absences_v')
      .select('*')
      .eq('user_id', userId)
      .order('start_date', { ascending: false })
      .order('id', { ascending: false })
      .limit(300),
  );

export function schoolAbsences({ from, to, status, q, user_id: userId } = {}) {
  let query = sb.from('absences_v').select('*');
  if (from) query = query.gte('end_date', from);
  if (to) query = query.lte('start_date', to);
  if (status === 'active') query = query.neq('status', 'cancelled');
  else if (['pending', 'received', 'cancelled'].includes(status)) query = query.eq('status', status);
  if (q) query = query.ilike('employee_name', `%${q.replace(/[%_,()]/g, ' ').slice(0, 100)}%`);
  if (userId) query = query.eq('user_id', userId);
  return run(query.order('start_date', { ascending: false }).order('id', { ascending: false }).limit(500));
}

export async function dashboard(today = todayStr()) {
  const horizon = addDays(today, 14);
  const active = () => sb.from('absences_v').select('*').neq('status', 'cancelled');
  const [todayList, upcoming, pending] = await Promise.all([
    run(active().lte('start_date', today).gte('end_date', today).order('partial').order('employee_name')),
    run(active().gt('start_date', today).lte('start_date', horizon).order('start_date').order('employee_name')),
    run(sb.from('absences_v').select('*').eq('status', 'pending').order('created_at', { ascending: false }).limit(50)),
  ]);
  return {
    today,
    today_list: todayList,
    upcoming,
    pending,
    counts: {
      today: todayList.length,
      uncovered_today: todayList.filter((a) => !coversOn(a, today).length && !a.no_cover && roleNeedsCoverage(a.employee_role)).length,
      pending: pending.length,
      upcoming: upcoming.length,
    },
  };
}

export async function getAbsence(id) {
  const [absence, attachments, comments, history] = await Promise.all([
    run(sb.from('absences_v').select('*').eq('id', id).maybeSingle()),
    run(sb.from('attachments').select('*').eq('absence_id', id).order('id')),
    run(sb.from('comments').select('*').eq('absence_id', id).order('id')),
    run(sb.from('absence_history').select('*').eq('absence_id', id).order('id')),
  ]);
  if (!absence) throw new ApiError('No se encontró la ausencia.', 404);
  await signFiles(attachments);
  // The plan or material for whoever covers: the coverage form says they get it.
  absence.cover_files = attachments.filter((f) => f.for_cover).length;
  return { absence, attachments, comments, history };
}

/** Links that open each file for an hour (url; null if it can't be read). */
async function signFiles(files) {
  if (files.length) {
    const { data } = await sb.storage.from(BUCKET).createSignedUrls(files.map((f) => f.path), 3600);
    const urls = new Map((data || []).map((d) => [d.path, d.signedUrl]));
    for (const f of files) f.url = urls.get(f.path) || null;
  }
  return files;
}

/**
 * The plan or material the absent teacher left for whoever covers: whoever covers can read only these (never the
 * excuse), until the coverage is taken from them or the absence is cancelled.
 */
export const getCoverFiles = async (absenceId) =>
  signFiles(
    await run(
      sb.from('attachments').select('id, path, original_name, mime, size, uploaded_by_name, created_at')
        .eq('absence_id', absenceId).eq('for_cover', true).order('id'),
    ),
  );

const EXT_TYPES = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const ALLOWED_TYPES = new Set(Object.values(EXT_TYPES));

/** Phones sometimes send HEIC photos or Word files without a MIME type, so fall back to the extension. */
function fileType(file) {
  if (ALLOWED_TYPES.has(file.type)) return file.type;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return EXT_TYPES[ext] || null;
}

export function checkFile(file) {
  if (!fileType(file)) return `“${file.name}” no es un tipo permitido. Usa PDF, foto o Word.`;
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) return `“${file.name}” pesa más de ${MAX_UPLOAD_MB} MB.`;
  return null;
}

async function uploadFiles(files, me) {
  const uploaded = [];
  try {
    for (const file of files) {
      const type = fileType(file);
      const ext = Object.keys(EXT_TYPES).find((k) => EXT_TYPES[k] === type) || 'bin';
      const path = `${me.school.id}/${me.user.id}/${crypto.randomUUID()}.${ext}`;
      const { error } = await sb.storage.from(BUCKET).upload(path, file, { contentType: type, upsert: false });
      if (error) {
        throw new ApiError(
          /size|large/i.test(error.message) ? `“${file.name}” es demasiado grande.` : `No se pudo subir “${file.name}”.`,
        );
      }
      uploaded.push({ path, name: file.name });
    }
    return uploaded;
  } catch (err) {
    removeFiles(uploaded.map((f) => f.path));
    throw err;
  }
}

function removeFiles(paths) {
  if (paths.length) sb.storage.from(BUCKET).remove(paths).catch(() => {});
}

/** files: the excuse or evidence (only the employee and the dirección see it); coverFiles: for whoever covers. */
export async function createAbsence(me, v, files, coverFiles = []) {
  const uploaded = (await uploadFiles([...files, ...coverFiles], me)).map((f, i) => (i < files.length ? f : { ...f, cover: true }));
  try {
    return await rpc('create_absence', {
      p_start_date: v.start_date,
      p_end_date: v.end_date || null,
      p_partial: v.partial === '1',
      p_start_time: v.partial === '1' ? v.start_time || null : null,
      p_end_time: v.partial === '1' ? v.end_time || null : null,
      p_category: v.category || null,
      p_reason: v.reason || null,
      p_coverage_notes: v.coverage_notes || null,
      p_user_id: v.user_id || null,
      p_today: todayStr(),
      p_files: uploaded,
    });
  } catch (err) {
    removeFiles(uploaded.map((f) => f.path));
    throw err;
  }
}

/** cover: the plan or material for whoever covers (they get a notice); otherwise the excuse or evidence. */
export async function addAttachments(me, absenceId, files, { cover = false } = {}) {
  const uploaded = await uploadFiles(files, me);
  try {
    await rpc('add_attachments', { p_absence_id: absenceId, p_files: cover ? uploaded.map((f) => ({ ...f, cover: true })) : uploaded });
  } catch (err) {
    removeFiles(uploaded.map((f) => f.path));
    throw err;
  }
}

export async function deleteAttachment(id) {
  const path = await rpc('delete_attachment', { p_id: id });
  removeFiles([path]);
}

export const receiveAbsence = (id, comment) => rpc('receive_absence', { p_id: id, p_comment: comment || null });
/**
 * Who covers: the whole list, in order. Each: substituteId for someone of the staff (they get a notice with their
 * days, groups, hours, room and the instructions) or name for someone from outside; days (dates of the absence,
 * [] = every day), groups, room, and start / end (optional, "HH:MM"; by default the absence's hours). The same
 * person can be in more than one row on different days. An empty list removes the coverage. The absent person
 * gets no notice: they see it in their absence.
 */
export const setCovers = (id, covers) =>
  rpc('set_absence_covers', {
    p_id: id,
    p_covers: covers.map((c) => ({
      substitute_id: c.substituteId || null,
      name: c.name || null,
      days: c.days || [],
      groups: c.groups || [],
      room: c.room || null,
      start_time: c.start || null,
      end_time: c.end || null,
    })),
  });

/**
 * «Nadie cubrirá»: reason 'not_needed' (no hace falta) or 'no_one' (no hay quién cubra); null undoes it. Whoever
 * covered is taken off and told. Assigning someone later undoes it too.
 */
export const setNoCover = (id, reason) => rpc('set_absence_no_cover', { p_id: id, p_reason: reason || null });

/**
 * What I cover (Vas a cubrir): from a day on, one row per row of the list (cover_days: my days, null = every day),
 * with my hours, who else covers and my answers (received_at, on_the_way_at). No type or reason of the absence.
 */
export const myCoverages = (from) => rpc('my_coverages', { p_from: from });

/** My rows of one coverage, also a cancelled one; [] if it's no longer mine. */
export const getCoverage = async (id) => (await rpc('my_coverages', { p_id: id })) || [];
/**
 * Whoever covers answers whoever assigned it: 'received' («Recibido») or 'on_the_way' («Voy en camino», on day: a
 * day they cover). Saying it again doesn't tell them again.
 */
export const replyCoverage = (id, step, day) => rpc('reply_coverage', { p_id: id, p_step: step, p_day: day || null });
export const addComment = (id, body) => rpc('add_comment', { p_id: id, p_body: body });
/** reason: 'no_absence' | 'error' | 'other' (note required for 'other'). */
export const cancelAbsence = (id, reason, note) =>
  rpc('cancel_absence', { p_id: id, p_reason: reason, p_note: note || null });

export const updateAbsence = (id, v) =>
  rpc('update_absence', {
    p_id: id,
    p_start_date: v.start_date,
    p_end_date: v.end_date || null,
    p_partial: v.partial === '1',
    p_start_time: v.partial === '1' ? v.start_time || null : null,
    p_end_time: v.partial === '1' ? v.end_time || null : null,
    p_category: v.category || null,
    p_reason: v.reason || null,
    p_coverage_notes: v.coverage_notes || null,
    p_note: v.note || null,
    p_today: todayStr(),
  });

// ---- Avisos -----------------------------------------------------------------

export async function listNotifications() {
  const [notifications, unread] = await Promise.all([
    run(sb.from('notifications').select('*').order('id', { ascending: false }).limit(100)),
    unreadCount(),
  ]);
  return { notifications, unread };
}

export async function unreadCount() {
  const { count, error } = await sb.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null);
  if (error) throw toApiError(error);
  return count || 0;
}

export const markNotificationRead = (id) => rpc('mark_notification_read', { p_id: id });
export const markAllNotificationsRead = () => rpc('mark_all_notifications_read');

export function savePushSubscription(sub) {
  const json = sub.toJSON();
  return rpc('save_push_subscription', { p_endpoint: json.endpoint, p_p256dh: json.keys.p256dh, p_auth: json.keys.auth });
}
export const deletePushSubscription = (endpoint) => rpc('delete_push_subscription', { p_endpoint: endpoint });
export const testPush = () => rpc('test_push');

// ---- Personal (dirección) ------------------------------------------------------

function withRoleLabel(e) {
  return e && { ...e, role_label: roleLabel(e.role) };
}

export async function listEmployees() {
  const rows = await run(
    sb.from('employees_v').select('*').order('active', { ascending: false }).order('full_name'),
  );
  return rows.map(withRoleLabel);
}

export async function getEmployee(id) {
  const row = await run(sb.from('employees_v').select('*').eq('id', id).maybeSingle());
  if (!row) throw new ApiError('Empleado no encontrado.', 404);
  return withRoleLabel(row);
}

export const createEmployee = (v) => callFunction('admin', { action: 'create_employee', ...v });
export const updateEmployee = (id, v) => callFunction('admin', { action: 'update_employee', id, ...v });
export const resetEmployeePassword = (id) => callFunction('admin', { action: 'reset_password', id });
export const deleteEmployee = (id) => callFunction('admin', { action: 'delete_employee', id });
export const setAdminPassword = (current, next) =>
  callFunction('admin', { action: 'set_admin_password', current_password: current, new_password: next });
/** target: 'main' (absences channel) or 'password' (forgotten-password channel). */
export const testTeams = (target = 'main') => callFunction('admin', { action: 'test_teams', target });

// ---- Correo y mensajes -------------------------------------------------------------

export const saveEmailAccount = (v) =>
  rpc('save_email_account', {
    p_provider: v.provider,
    p_from_email: v.from_email,
    p_from_name: v.from_name || null,
    p_password: v.password || null,
    p_smtp_host: v.smtp_host || null,
    p_smtp_port: v.smtp_port ? Number(v.smtp_port) : null,
    p_smtp_user: v.smtp_user || null,
  });
export const removeEmailAccount = () => rpc('remove_email_account');
/** Null subject and body restore the default text. */
export const saveWelcomeTemplate = (subject, body) => rpc('save_welcome_template', { p_subject: subject, p_body: body });
export const testEmail = () => callFunction('admin', { action: 'test_email' });
export const sendCredentials = (id, password) => callFunction('admin', { action: 'send_credentials', id, password });
/** New temporary passwords for these people who haven't signed in yet: { people: [{ id, full_name, username, password } | { …, error }] }. */
export const resetNeverSignedIn = (ids) => callFunction('admin', { action: 'reset_never_signed_in', ids });
/** to: 'all' | a role key | [employee ids] */
export const sendMessage = ({ to, subject, body, email }) =>
  callFunction('admin', { action: 'send_message', to, subject, body, email: !!email });

/** kind 'welcome' (subject/body = template being edited) or 'message'. Returns { subject, html }. */
export const previewEmail = (kind, subject, body) => callFunction('admin', { action: 'preview_email', kind, subject, body });

/** Moves every account of the school to the new code and tells everyone. */
export const changeSchoolCode = (code) => callFunction('admin', { action: 'change_school_code', code });

/** Creates (no key) or changes a role. Returns { role }. */
export const saveRole = ({ key, name, permissions, coverage }) =>
  callFunction('admin', { action: 'save_role', key: key || null, name, permissions, coverage });

export const deleteRole = (key) => callFunction('admin', { action: 'delete_role', key });

export const listMessages = () =>
  run(sb.from('messages').select('*').order('created_at', { ascending: false }).limit(100));

export async function getMessage(id) {
  const [message, recipients] = await Promise.all([
    run(sb.from('messages').select('*').eq('id', id).maybeSingle()),
    run(sb.from('message_recipients').select('user_id, email_status, profile:profiles(full_name, email)').eq('message_id', id)),
  ]);
  if (!message) throw new ApiError('No se encontró el mensaje.', 404);
  recipients.sort((a, b) => (a.profile?.full_name || '').localeCompare(b.profile?.full_name || ''));
  return { message, recipients };
}

// ---- Escuela ---------------------------------------------------------------------

export async function getSchool(schoolId) {
  const [school, settings] = await Promise.all([
    run(sb.from('schools').select('id, code, name, created_at').eq('id', schoolId).single()),
    run(sb.from('school_settings').select('*').eq('school_id', schoolId).maybeSingle()),
  ]);
  return { ...school, ...(settings || { teams_enabled: true, teams_include_reason: true }) };
}

export const updateSchool = (v) =>
  rpc('update_school', {
    p_name: v.name ?? null,
    p_teams_webhook_url: v.teams_webhook_url ?? null,
    p_teams_enabled: v.teams_enabled ?? null,
    p_teams_include_reason: v.teams_include_reason ?? null,
    p_update_teams_url: 'teams_webhook_url' in v,
    p_teams_password_webhook_url: v.teams_password_webhook_url ?? null,
    p_update_teams_password_url: 'teams_password_webhook_url' in v,
  });

// ---- Calendario escolar -------------------------------------------------------------

/** Days without classes, from a date on (all of them without one), in date order. */
export function listClosures({ from } = {}) {
  let q = sb.from('school_closures').select('*').order('start_date').order('id');
  if (from) q = q.gte('end_date', from);
  return run(q.limit(500));
}

/** Adds (no id) or changes a day or period without classes. kind: 'holiday' | 'no_classes'. */
export const saveClosure = ({ id, start, end, name, kind }) =>
  rpc('save_closure', { p_id: id || null, p_start: start, p_end: end || null, p_name: name, p_kind: kind });
export const deleteClosure = (id) => callFunction('admin', { action: 'delete_closure', id });

/** Class hours and school days (ISO weekdays). Returns the school calendar. */
/** When the conference room can be reserved ("HH:MM"), apart from the class hours. Returns the school's calendar. */
export const saveRoomHours = (start, end) => rpc('save_room_hours', { p_start: start, p_end: end });
export const saveSchoolHours = (start, end, days) =>
  rpc('save_school_hours', { p_day_start: start, p_day_end: end, p_school_days: days });

// Each one returns the school's list of grades and groups.
export const addSchoolGroups = (names) => rpc('add_school_groups', { p_names: names });
export const renameSchoolGroup = (oldName, newName) => rpc('rename_school_group', { p_old: oldName, p_new: newName });
export const removeSchoolGroup = (name) => rpc('remove_school_group', { p_name: name });

// ---- Alertas: «No ha llegado», salidas y relevos ------------------------------------

/** Start of today on this device, so "today" is the school's local day. */
const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

/** What is open now, and what was resolved today. */
export async function listAlerts() {
  const today = startOfToday();
  const relief = new Date(Date.now() - 2 * 3600000).toISOString();
  const [missing, pickups, reliefs] = await Promise.all([
    run(sb.from('student_alerts_v').select('*').or(`resolved_at.is.null,created_at.gte.${today}`).order('created_at', { ascending: false }).limit(100)),
    run(sb.from('student_pickups_v').select('*').or(`status.in.(scheduled,arrived,on_the_way),created_at.gte.${today}`).order('created_at').limit(200)),
    run(sb.from('relief_requests').select('*').gte('created_at', relief).order('created_at', { ascending: false }).limit(50)),
  ]);
  return { missing, pickups, reliefs };
}

async function one(table, id, message) {
  const row = await run(sb.from(table).select('*').eq('id', id).maybeSingle());
  if (!row) throw new ApiError(message, 404);
  return row;
}
export const getMissingAlert = (id) => one('student_alerts_v', id, 'No se encontró la alerta.');
export const getPickup = (id) => one('student_pickups_v', id, 'No se encontró la salida.');
export const getRelief = (id) => one('relief_requests', id, 'No se encontró el pedido de relevo.');

/** Students noted today in that group with a similar name: [{ id, name, group_name, exact }]. */
export const similarStudents = (name, group) => rpc('similar_students', { p_name: name, p_group: group });

/** student: { id } of one noted today, or { name, group } for a new one. audience: 'security' | 'all'. */
export const createStudentAlert = ({ student, place, room, note, audience }) =>
  rpc('create_student_alert', {
    p_student_id: student.id || null,
    p_name: student.name || null,
    p_group: student.group || null,
    p_place: place || null,
    p_room: room || null,
    p_note: note || null,
    p_audience: audience,
  });
export const resolveStudentAlert = (id, foundPlace) => rpc('resolve_student_alert', { p_id: id, p_found_place: foundPlace || null });

export const createPickup = ({ student, time, room, note }) =>
  rpc('create_pickup', {
    p_student_id: student.id || null,
    p_name: student.name || null,
    p_group: student.group || null,
    p_time: time || null,
    p_room: room || null,
    p_note: note || null,
  });
/** step: 'arrived' | 'on_the_way' | 'delivered' | 'cancelled'. */
export const advancePickup = (id, step, pickedUpBy) =>
  rpc('advance_pickup', { p_id: id, p_step: step, p_picked_up_by: pickedUpBy || null });

export const requestRelief = (room, note) => rpc('request_relief', { p_room: room || null, p_note: note || null });
export const takeRelief = (id) => rpc('take_relief', { p_id: id });
export const cancelRelief = (id) => rpc('cancel_relief', { p_id: id });

/** Seen: stops the repeated pushes (all alerts, all turns with '#/turns', or one link like '#/alerts/missing/3'). */
export const markAlertsRead = (link = null) => rpc('mark_alerts_read', { p_link: link });

// ---- Turnos (Enfermería, Trabajo Social…) -----------------------------------------------

/** [{ id, name, mode, arrive_minutes, roles, reasons, active, serves, waiting, staff: [{ id, name, status, until }] }] */
export const servicesOverview = () => rpc('services_overview');

/** status: 'available' | 'meeting' | 'lunch' | 'away'; until: ISO time (required for 'away'). */
export const setMyServiceStatus = (status, until) => rpc('set_my_service_status', { p_status: status, p_until: until || null });

export const saveService = ({ id, name, mode, arriveMinutes, roles, reasons, active }) =>
  rpc('save_service', {
    p_id: id || null,
    p_name: name,
    p_mode: mode,
    p_arrive_minutes: arriveMinutes,
    p_roles: roles,
    p_reasons: reasons,
    p_active: active,
  });

/** The turns still open and the ones from today (each person only gets the ones they may see). */
export function listTurns() {
  return run(
    sb
      .from('service_requests_v')
      .select('*')
      .or(`status.in.(waiting,called,sent,arrived,on_the_way,returning),created_at.gte.${startOfToday()}`)
      .order('created_at')
      .limit(300),
  );
}
export const getTurn = (id) => one('service_requests_v', id, 'No se encontró el turno.');

/** The same student's earlier turns in that service (only the service sees them). */
export const turnHistory = (t) =>
  run(
    sb
      .from('service_requests_v')
      .select('id, created_at, status, outcome, reason, severity')
      .eq('service_id', t.service_id)
      .eq('student_key', t.student_key)
      .eq('group_name', t.group_name)
      .neq('id', t.id)
      .order('created_at', { ascending: false })
      .limit(10),
  );

/**
 * student: { id } of one noted today, or { name, group } ({} for support services such as Soporte IT, where the room
 * is where the help is needed). here: the professional notes a student already in the office.
 */
export const requestService = ({ serviceId, student, room, severity, reason, note, here }) =>
  rpc('request_service', {
    p_service_id: serviceId,
    p_student_id: student.id || null,
    p_name: student.name || null,
    p_group: student.group || null,
    p_room: room || null,
    p_severity: severity,
    p_reason: reason || null,
    p_note: note || null,
    p_here: !!here,
  });

/** step: call · go · sent · arrived · return · back · finish (value: the outcome) · cancel · take (value: the room). */
export const advanceTurn = (id, step, value) => rpc('advance_turn', { p_id: id, p_step: step, p_value: value || null });
/** What the service did (Soporte IT), for the panel and the Excel. */
export const noteTurnResolution = (id, text) => rpc('note_turn_resolution', { p_id: id, p_text: text || null });

// ---- Visitas (llega un padre y busca a alguien) ------------------------------------------

/** For the form: { services: [{ id, name, staff: [{ name, status, until }] }], people: [{ id, name, position, room, role }] }. */
export const visitTargets = () => rpc('visit_targets');

/** Today's visits (each person only gets the ones they may see). */
export const listVisits = () => run(sb.from('visits').select('*').gte('created_at', startOfToday()).order('created_at').limit(200));
export const getVisit = (id) => one('visits', id, 'No se encontró la visita.');

/** to: { serviceId } (everyone who attends it) or { personId }. appointment: whether they're citado. */
export const createVisit = ({ visitor, student, to, appointment, place, note }) =>
  rpc('create_visit', {
    p_visitor: visitor,
    p_student: student || null,
    p_service_id: to.serviceId || null,
    p_target_id: to.personId || null,
    p_appointment: appointment,
    p_place: place,
    p_note: note || null,
  });
/** answer: 'on_the_way' · 'come' (place: where they go) · 'wait' (note: how long) · 'other' (note: what). */
export const answerVisit = (id, answer, { place, note } = {}) =>
  rpc('answer_visit', { p_id: id, p_answer: answer, p_place: place || null, p_note: note || null });
/** status: 'done' (atendida) · 'cancelled' (se fue). */
export const closeVisit = (id, status) => rpc('close_visit', { p_id: id, p_status: status });

// ---- Mantenimiento ------------------------------------------------------------------------

const MAINTENANCE_BUCKET = 'maintenance';
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

/**
 * Phone photos are big: a JPEG up to 1600 px is plenty to see a spill. A photo the browser can't open
 * (HEIC outside Safari) goes as it is.
 */
async function shrinkPhoto(file) {
  try {
    const bitmap = await window.createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
    if (blob) return { blob, type: 'image/jpeg', ext: 'jpg' };
  } catch {
    /* the browser can't read it */
  }
  const type = fileType(file);
  if (!PHOTO_TYPES.includes(type)) throw new ApiError('La foto debe ser JPG, PNG, WEBP o HEIC.');
  if (file.size > 5 * 1024 * 1024) throw new ApiError('La foto pesa más de 5 MB.');
  return { blob: file, type, ext: Object.keys(EXT_TYPES).find((k) => EXT_TYPES[k] === type) };
}

/** { staff: [{ id, name }], pending, on_the_way } */
export const maintenanceOverview = () => rpc('maintenance_overview');

/** kind: spill · cleaning · bathroom · trash · repair · other; urgency 1 (Cuando puedan) … 3 (Urgente); photo: a File. */
export async function createMaintenanceRequest(me, { kind, place, urgency, note, photo }) {
  let path = null;
  if (photo) {
    const p = await shrinkPhoto(photo);
    path = `${me.school.id}/${me.user.id}/${crypto.randomUUID()}.${p.ext}`;
    const { error } = await sb.storage.from(MAINTENANCE_BUCKET).upload(path, p.blob, { contentType: p.type, upsert: false });
    if (error) throw new ApiError('No se pudo subir la foto. Inténtalo de nuevo o envía la solicitud sin foto.');
  }
  try {
    return await rpc('create_maintenance_request', {
      p_kind: kind,
      p_place: place,
      p_urgency: urgency,
      p_note: note || null,
      p_photo_path: path,
    });
  } catch (err) {
    if (path) sb.storage.from(MAINTENANCE_BUCKET).remove([path]).catch(() => {});
    throw err;
  }
}

/** The open requests and the ones from today (each person only gets the ones they may see). */
export function listMaintenance() {
  return run(
    sb
      .from('maintenance_requests_v')
      .select('*')
      .or(`status.in.(pending,on_the_way),created_at.gte.${startOfToday()}`)
      .order('created_at')
      .limit(300),
  );
}

/** What I asked for that is still open (Alertas lists them). */
export const myOpenMaintenance = (userId) =>
  run(
    sb
      .from('maintenance_requests_v')
      .select('*')
      .eq('created_by', userId)
      .in('status', ['pending', 'on_the_way'])
      .order('created_at')
      .limit(50),
  );

/** One request, with a link to its photo (valid for an hour). */
export async function getMaintenance(id) {
  const m = await one('maintenance_requests_v', id, 'No se encontró la solicitud.');
  if (m.photo_path) {
    const { data } = await sb.storage.from(MAINTENANCE_BUCKET).createSignedUrls([m.photo_path], 3600);
    m.photo_url = data?.[0]?.signedUrl || null;
  }
  return m;
}

/** step: go · release · done (note: what was done) · cancel (note: why). */
export const advanceMaintenance = (id, step, note) => rpc('advance_maintenance', { p_id: id, p_step: step, p_note: note || null });

// ---- Reservas del salón de conferencias ------------------------------------------------

/** Reservations between two dates: everyone's waiting and approved ones, plus my own (and all, for Secretaría). */
export const listBookings = (from, to) =>
  run(sb.from('room_bookings').select('*').gte('day', from).lte('day', to).order('day').order('start_time').limit(1000));

/** My reservations from a date on (Reservas lists them). */
export const myBookings = (userId, from) =>
  run(sb.from('room_bookings').select('*').eq('created_by', userId).gte('day', from).order('day').order('start_time').limit(100));

/** Requests waiting for Secretaría or the dirección, oldest day first. */
export const pendingBookings = (from) =>
  run(sb.from('room_bookings').select('*').eq('status', 'pending').gte('day', from).order('day').order('start_time').limit(200));

/**
 * History: reservations asked, approved, rejected, cancelled or replaced since a date (all of them without one),
 * newest first. userId: only that person's (whoever doesn't approve sees only their own).
 */
export const bookingHistory = ({ since = null, userId = null } = {}) => {
  let q = sb.from('room_bookings').select('*');
  if (since) q = q.or(`created_at.gte.${since},approved_at.gte.${since},closed_at.gte.${since}`);
  if (userId) q = q.eq('created_by', userId);
  return run(q.order('id', { ascending: false }).limit(1000));
};

export const getBooking = (id) => one('room_bookings', id, 'No se encontró la reserva.');

/** Secretaría and the dirección need replace: true to take a time someone else has. note: for whoever approves. */
export const createBooking = ({ day, start, end, purpose, replace = false, note = '' }) =>
  rpc('create_room_booking', { p_day: day, p_start: start, p_end: end, p_purpose: purpose, p_replace: replace, p_note: note || null });

/** The reservation's notes (only whoever asked and Secretaría / the dirección see them). */
export const bookingNotes = (id) => run(sb.from('room_booking_notes').select('*').eq('booking_id', id).order('id'));
export const addBookingNote = (id, body) => rpc('add_room_booking_note', { p_id: id, p_body: body });

export const decideBooking = (id, approve, note) => rpc('decide_room_booking', { p_id: id, p_approve: approve, p_note: note || null });
export const cancelBooking = (id, note) => rpc('cancel_room_booking', { p_id: id, p_note: note || null });

// ---- Paneles ----------------------------------------------------------------------------

/** From the start of the phone's day `from` to the start of the day after `to`, as timestamps. */
export const dayBounds = (from, to) => [new Date(`${from}T00:00:00`).toISOString(), new Date(`${addDays(to, 1)}T00:00:00`).toISOString()];

/** A service's turns in a period, with the reason and never the note (the service and the dirección). */
export function serviceTurns(serviceId, from, to) {
  const [start, end] = dayBounds(from, to);
  return fetchAll(() => sb.rpc('service_turns', { p_service_id: serviceId, p_from: start, p_to: end }).order('id'));
}

/** Maintenance requests made in a period (Mantenimiento, the dirección and the secretaría see them all). */
export function maintenanceBetween(from, to) {
  const [start, end] = dayBounds(from, to);
  return fetchAll(() => sb.from('maintenance_requests').select('*').gte('created_at', start).lt('created_at', end).order('id'));
}

/** Conference room reservations for the days of a period. */
export const bookingsBetween = (from, to) =>
  fetchAll(() => sb.from('room_bookings').select('*').gte('day', from).lte('day', to).order('id'));

/** What is happening now in the school (the dirección's live board). */
export const liveBoard = () => rpc('live_board', { p_since: startOfToday(), p_today: todayStr() });
/** One service's turns of today (and any still open), with every step and how it ended; never the note. */
export const liveTurns = async (serviceId) => (await rpc('live_turns', { p_service_id: serviceId, p_since: startOfToday() })) || [];
/**
 * One turn, with everything about it, also the teacher's note: the student (or who asked and where), reason, how
 * serious, place in line, who asked, has the student and attends, every step with its time and how it ended.
 */
export const getLiveTurn = (id) => rpc('live_turn', { p_id: id });
/** How many turns a service had at each hour of the day over the 4 weeks before today: { days, hours: [{ hour, turns }] }. */
export const liveHours = (serviceId) => rpc('live_hours', { p_service_id: serviceId, p_since: startOfToday() });
/**
 * Resumen del día (permission summary): the staff's absences with who covered them, the services' turns, alerts,
 * visits and maintenance in numbers, and the next school day. day: 'YYYY-MM-DD' of the last 60 days; null = today.
 */
export const dailySummary = (day) => rpc('daily_summary', { p_day: day || null });

/** A service closes a finished period: its finished turns are deleted. */
export function closeServiceYear(serviceId, from, to) {
  const [start, end] = dayBounds(from, to);
  return callFunction('admin', { action: 'close_service_year', service_id: serviceId, from_ts: start, to_ts: end, confirm: 'BORRAR' });
}

/** sheets: [{ name, columns: [{ header, width, wrap }], rows }] */
export const downloadXlsx = (filename, sheets) => download(filename, buildXlsx(sheets));

// ---- Datos y reportes ------------------------------------------------------------

function absenceDays(a, from, to) {
  if (a.partial) return 0.5;
  const s = from && a.start_date < from ? from : a.start_date;
  const e = to && a.end_date > to ? to : a.end_date;
  return e < s ? 0 : weekdays(s, e);
}

export async function stats(from, to) {
  const rows = await schoolAbsences({ from, to, status: 'active' });
  const byEmployee = new Map();
  const byCategory = new Map();
  let totalDays = 0;
  for (const a of rows) {
    const days = absenceDays(a, from, to);
    totalDays += days;
    const e = byEmployee.get(a.user_id) || { user_id: a.user_id, full_name: a.employee_name, count: 0, days: 0 };
    e.count++;
    e.days += days;
    byEmployee.set(a.user_id, e);
    const key = a.category || 'sin_especificar';
    byCategory.set(key, (byCategory.get(key) || 0) + 1);
  }
  return {
    totals: {
      absences: rows.length,
      days: totalDays,
      employees: byEmployee.size,
      pending: rows.filter((a) => a.status === 'pending').length,
    },
    by_employee: [...byEmployee.values()].sort((a, b) => b.days - a.days || b.count - a.count),
    by_category: [...byCategory.entries()]
      .map(([category, count]) => ({ category, label: CATEGORIES[category] || 'Sin especificar', count }))
      .sort((a, b) => b.count - a.count),
  };
}

function download(filename, content, type) {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const HISTORY_ACTIONS = { edited: 'Modificada', cancelled: 'Cancelada', received: 'Recibida' };

const ABSENCE_COLUMNS = [
  { header: 'ID', width: 7 },
  { header: 'Empleado', width: 26 },
  { header: 'Puesto', width: 18 },
  { header: 'Desde', width: 12 },
  { header: 'Hasta', width: 12 },
  { header: 'Días laborables', width: 10 },
  { header: 'Horario', width: 15 },
  { header: 'Tipo', width: 20 },
  { header: 'Causa', width: 40, wrap: true },
  { header: 'Instrucciones para cubrir', width: 40, wrap: true },
  { header: 'Estado', width: 11 },
  { header: 'Recibida por', width: 22 },
  { header: 'Fecha recibida', width: 17 },
  { header: 'Cubierto por', width: 30, wrap: true },
  { header: 'Documentos', width: 11 },
  { header: 'Comentarios', width: 12 },
  { header: 'Registrada por', width: 22 },
  { header: 'Creada', width: 17 },
  { header: 'Cancelada', width: 17 },
  { header: 'Motivo de cancelación', width: 30, wrap: true },
];

const scheduleLabel = (a) => scheduleText(a).replace(/\u00a0/g, ' ');

/** "José Pérez (lun 12 oct); Ana Ruiz (mar 13 oct)": who covers, with their days when not every day. */
const coveredBy = (a) =>
  a.covers?.some((c) => c.days?.length)
    ? a.covers.map((c) => (c.days?.length ? `${c.name} (${c.days.map((d) => fmtDate(d).replace(/[,.]/g, '')).join(', ')})` : c.name)).join('; ')
    : a.substitute || (NO_COVER[a.no_cover] ? `Nadie: ${NO_COVER[a.no_cover].label.toLowerCase()}` : '');

function absenceRow(a, cancelReasons = new Map()) {
  return [
    a.id, a.employee_name, a.employee_position, xDate(a.start_date), xDate(a.end_date), absenceDays(a),
    scheduleLabel(a), CATEGORIES[a.category] || '', a.reason, a.coverage_notes, STATUS[a.status]?.label,
    a.received_by_name, xDateTime(a.received_at), coveredBy(a), a.attachment_count, a.comment_count,
    a.created_by_name, xDateTime(a.created_at), xDateTime(a.cancelled_at), cancelReasons.get(a.id),
  ];
}

const absencesQuery = ({ from, to } = {}) => () => {
  let q = sb.from('absences_v').select('*');
  if (from) q = q.gte('end_date', from);
  if (to) q = q.lte('start_date', to);
  return q.order('start_date').order('id');
};

export async function exportAbsencesXlsx(code, { from, to } = {}) {
  const rows = await fetchAll(absencesQuery({ from, to }));
  const history = await fetchByIds('absence_history', 'absence_id', rows.filter((a) => a.status === 'cancelled').map((a) => a.id));
  const reasons = new Map(history.filter((h) => h.action === 'cancelled').map((h) => [h.absence_id, h.note]));
  const suffix = from || to ? `_${from || 'inicio'}_${to || 'hoy'}` : '';
  download(
    `ausencias_${code}${suffix}.xlsx`,
    buildXlsx([{ name: 'Ausencias', columns: ABSENCE_COLUMNS, rows: rows.map((a) => absenceRow(a, reasons)) }]),
  );
}

export async function exportEmployeesXlsx(code) {
  const rows = await listEmployees();
  const columns = [
    { header: 'Nombre', width: 28 }, { header: 'Usuario', width: 18 }, { header: 'Rol', width: 14 },
    { header: 'Puesto', width: 20 }, { header: 'Correo', width: 28 }, { header: 'Teléfono', width: 15 },
    { header: 'Núm. empleado', width: 14 }, { header: 'Salón', width: 12 }, { header: 'Grupos', width: 18 },
    { header: 'Activo', width: 8 }, { header: 'Ausencias', width: 10 },
    { header: 'Último acceso', width: 17 }, { header: 'Creado', width: 17 },
  ];
  download(
    `empleados_${code}.xlsx`,
    buildXlsx([{
      name: 'Personal',
      columns,
      rows: rows.map((u) => [
        u.full_name, u.username, roleLabel(u.role), u.position, u.email, u.phone, u.employee_number,
        u.room, (u.groups || []).join(', '), u.active ? 'Sí' : 'No', u.absence_count, xDateTime(u.last_login_at), xDateTime(u.created_at),
      ]),
    }]),
  );
}

export async function exportBackupJson(school) {
  const all = (table, select = '*') => fetchAll(() => sb.from(table).select(select).order('id'));
  const [employees, absences, history, comments, attachments, closures, services, bookings] = await Promise.all([
    run(sb.from('profiles').select('id, role, username, full_name, email, phone, employee_number, position, room, groups, active, last_login_at, created_at')),
    all('absences'),
    all('absence_history'),
    all('comments'),
    all('attachments', 'id, absence_id, uploaded_by, uploaded_by_name, original_name, mime, size, for_cover, created_at'),
    all('school_closures', 'id, start_date, end_date, name, kind, created_at'),
    // How the services work (the turns stay with each service).
    all('school_services', 'id, name, mode, arrive_minutes, roles, reasons, active, position, created_at'),
    all('room_bookings', 'id, day, start_time, end_time, purpose, status, priority, created_by_name, created_at, approved_by_name, approved_at, closed_by_name, closed_at, close_note'),
  ]);
  const backup = {
    generated_at: new Date().toISOString(),
    school: { code: school.code, name: school.name },
    calendar: school.calendar, school_closures: closures, school_services: services, room_bookings: bookings,
    employees, absences, absence_history: history, comments, attachments,
  };
  download(`respaldo_${school.code}_${todayStr()}.json`, JSON.stringify(backup, null, 2), 'application/json');
}

// ---- Archivo anual -------------------------------------------------------------------
// A period is archived by the day each absence starts, so an absence that crosses the end of the
// school year belongs to the year in which it began.

/** First day with data, to offer the school years that exist. */
export async function firstAbsenceDate() {
  const rows = await run(sb.from('absences').select('start_date').order('start_date').limit(1));
  return rows[0]?.start_date || null;
}

export const archiveRuns = () => run(sb.from('archive_runs').select('*').order('created_at', { ascending: false }).limit(5));

export async function archiveData(from, to) {
  const absences = await fetchAll(() =>
    sb.from('absences_v').select('*').gte('start_date', from).lte('start_date', to).order('start_date').order('id'),
  );
  const ids = absences.map((a) => a.id);
  const [attachments, comments, history] = await Promise.all([
    fetchByIds('attachments', 'absence_id', ids),
    fetchByIds('comments', 'absence_id', ids),
    fetchByIds('absence_history', 'absence_id', ids),
  ]);
  const byStatus = { pending: 0, received: 0, cancelled: 0 };
  for (const a of absences) byStatus[a.status]++;
  return {
    from, to, absences, attachments, comments, history, byStatus,
    bytes: attachments.reduce((n, f) => n + (f.size || 0), 0),
  };
}

const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'archivo';

/** Where each document goes inside the ZIP: one folder per absence. */
function zipPaths(data) {
  const absences = new Map(data.absences.map((a) => [a.id, a]));
  const used = new Set();
  const paths = new Map();
  for (const f of data.attachments) {
    const a = absences.get(f.absence_id);
    const folder = `${a.start_date} ${safeName(a.employee_name)} (#${a.id})`;
    let name = safeName(f.original_name);
    for (let n = 2; used.has(`${folder}/${name}`); n++) name = safeName(f.original_name).replace(/(\.[^.]*)?$/, ` (${n})$1`);
    used.add(`${folder}/${name}`);
    paths.set(f.id, `${folder}/${name}`);
  }
  return paths;
}

export function exportArchiveXlsx(school, data) {
  const names = new Map(data.absences.map((a) => [a.id, a.employee_name]));
  const reasons = new Map(data.history.filter((h) => h.action === 'cancelled').map((h) => [h.absence_id, h.note]));
  const paths = zipPaths(data);

  const perEmployee = new Map();
  for (const a of data.absences) {
    if (a.status === 'cancelled') continue;
    const e = perEmployee.get(a.user_id) || [a.employee_name, a.employee_position, 0, 0, 0];
    e[2]++;
    e[3] += absenceDays(a);
    if (a.status === 'pending') e[4]++;
    perEmployee.set(a.user_id, e);
  }

  const blob = buildXlsx([
    { name: 'Ausencias', columns: ABSENCE_COLUMNS, rows: data.absences.map((a) => absenceRow(a, reasons)) },
    {
      name: 'Por empleado',
      columns: [
        { header: 'Empleado', width: 28 }, { header: 'Puesto', width: 20 }, { header: 'Ausencias', width: 11 },
        { header: 'Días laborables', width: 15 }, { header: 'Sin confirmar', width: 13 },
      ],
      rows: [...perEmployee.values()].sort((x, y) => y[3] - x[3]),
    },
    {
      name: 'Historial',
      columns: [
        { header: 'Ausencia', width: 9 }, { header: 'Empleado', width: 26 }, { header: 'Fecha', width: 17 },
        { header: 'Acción', width: 12 }, { header: 'Por', width: 22 }, { header: 'Cambios', width: 60, wrap: true },
        { header: 'Nota', width: 40, wrap: true },
      ],
      rows: data.history.map((h) => [
        h.absence_id, names.get(h.absence_id), xDateTime(h.created_at), HISTORY_ACTIONS[h.action], h.actor_name,
        (h.changes || []).map((c) => `${c.label}: ${c.before || '—'} → ${c.after || '—'}`).join('\n'), h.note,
      ]),
    },
    {
      name: 'Comentarios',
      columns: [
        { header: 'Ausencia', width: 9 }, { header: 'Empleado', width: 26 }, { header: 'Fecha', width: 17 },
        { header: 'Autor', width: 22 }, { header: 'Rol', width: 14 }, { header: 'Comentario', width: 60, wrap: true },
      ],
      rows: data.comments.map((c) => [
        c.absence_id, names.get(c.absence_id), xDateTime(c.created_at), c.author_name, roleLabel(c.author_role), c.body,
      ]),
    },
    {
      name: 'Documentos',
      columns: [
        { header: 'Ausencia', width: 9 }, { header: 'Empleado', width: 26 }, { header: 'Archivo', width: 30 },
        { header: 'Tamaño (KB)', width: 12 }, { header: 'Subido por', width: 22 }, { header: 'Fecha', width: 17 },
        { header: 'Para quien cubre', width: 16 }, { header: 'Carpeta en el ZIP', width: 60 },
      ],
      rows: data.attachments.map((f) => [
        f.absence_id, names.get(f.absence_id), f.original_name, Math.round((f.size || 0) / 1024), f.uploaded_by_name,
        xDateTime(f.created_at), f.for_cover ? 'Sí' : 'No', paths.get(f.id),
      ]),
    },
  ]);
  download(`archivo_${school.code}_${data.from}_${data.to}.xlsx`, blob);
}

/** Downloads every document of the period and saves them in one ZIP. onProgress(done, total). */
export async function exportArchiveZip(school, data, onProgress = () => {}) {
  const paths = zipPaths(data);
  const files = [];
  const failed = [];
  let done = 0;
  for (let i = 0; i < data.attachments.length; i += 100) {
    const batch = data.attachments.slice(i, i + 100);
    const { data: signed, error } = await sb.storage.from(BUCKET).createSignedUrls(batch.map((f) => f.path), 600);
    if (error) throw toApiError(error);
    const urls = new Map((signed || []).map((d) => [d.path, d.signedUrl]));
    // A few downloads at a time.
    const queue = [...batch];
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let f = queue.shift(); f; f = queue.shift()) {
          try {
            const res = await fetch(urls.get(f.path));
            if (!res.ok) throw new Error(String(res.status));
            files.push({ name: paths.get(f.id), data: new Uint8Array(await res.arrayBuffer()) });
          } catch {
            failed.push(f.original_name);
          }
          onProgress(++done, data.attachments.length);
        }
      }),
    );
  }
  if (failed.length) {
    throw new ApiError(`No se pudieron descargar ${failed.length} documento(s). Revisa tu conexión e inténtalo de nuevo.`);
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  download(`documentos_${school.code}_${data.from}_${data.to}.zip`, zip(files));
}

export const archivePurge = (from, to) => callFunction('admin', { action: 'archive_purge', from, to, confirm: 'BORRAR' });

// ---- Plataforma --------------------------------------------------------------------

// The platform password goes last so a payload field can never replace it.
export const platform = (password, action, payload = {}) =>
  callFunction('platform', { ...payload, action, password }, { auth: false });

// ---- Keep the app in sync when the session ends elsewhere ----------------------

sb.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') window.dispatchEvent(new CustomEvent('lah:signed-out'));
});
