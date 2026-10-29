// School administration actions that need Supabase Auth admin rights or the school's email account:
// employees (create, edit, deactivate, reset password, delete, email their access), roles, messages to the
// staff, the school admin password, the Teams and email tests, days off the school calendar and freeing
// space after an archive.
// Each action needs a permission of the person's role; the school's "admin" account has them all.
import {
  anonClient,
  authEmail,
  generatePassword,
  HttpError,
  json,
  optText,
  readJson,
  reqText,
  serve,
  serviceClient,
  validatePassword,
} from '../_shared/http.ts';
import { deleteAbsences } from '../_shared/cleanup.ts';
import { loadBranding, loadEmailAccount, schoolIconUrl, sendEmails } from '../_shared/email.ts';
import { isEmail, renderTemplate } from '../_shared/email_format.ts';
import { brandedHtml, LOGO_CID } from '../_shared/email_template.ts';
import { buildCard, postToTeams } from '../_shared/teams.ts';

const db = serviceClient();
const DUPLICATE = 'Ese usuario ya existe en esta escuela.';
const NO_PERMISSION = 'No tienes permiso para realizar esta acción.';
const EMPLOYEE_FIELDS =
  'id, role, username, full_name, email, phone, employee_number, position, active, must_change_password, last_login_at, created_at, updated_at, room, groups';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What a role can do besides reporting its own absences (see the roles migration). */
const PERMISSIONS = [
  'absences', 'register', 'staff', 'settings', 'services', 'messages', 'reports',
  'live', 'calendar', 'rooms', 'security', 'visitors', 'maintenance', 'summary',
];
/** Duties rather than powers over other people's data: whoever manages the staff can give them. */
const DUTIES = ['maintenance'];

type Role = { key: string; name: string; permissions: string[]; coverage: boolean; system: boolean; position: number };

type Me = {
  id: string;
  school_id: string;
  role: string;
  full_name: string;
  email: string | null;
  school: { code: string; name: string; icon_version: number | null };
  permissions: string[];
  /** The school's roles by key, including the hidden "admin" one. */
  roles: Map<string, Role>;
};

async function currentUser(req: Request): Promise<Me> {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data } = token ? await db.auth.getUser(token) : { data: { user: null } };
  if (!data.user) throw new HttpError(401, 'Tu sesión expiró. Vuelve a iniciar sesión.');
  const { data: me } = await db
    .from('profiles')
    .select('id, school_id, role, full_name, email, active, must_change_password, school:schools(code, name, active, icon_version)')
    .eq('id', data.user.id)
    .maybeSingle();
  // deno-lint-ignore no-explicit-any
  const school = (me as any)?.school;
  if (!me || !me.active || !school?.active) throw new HttpError(401, 'Tu sesión expiró. Vuelve a iniciar sesión.');
  if (me.must_change_password) throw new HttpError(403, 'Debes cambiar tu contraseña antes de continuar.');
  const { data: rows, error } = await db
    .from('school_roles')
    .select('key, name, permissions, coverage, system, position')
    .eq('school_id', me.school_id);
  if (error) throw new Error(error.message);
  const roles = new Map((rows as Role[]).map((r) => [r.key, r]));
  const permissions = me.role === 'admin' ? PERMISSIONS : roles.get(me.role)?.permissions || [];
  return { ...me, school, permissions, roles } as Me;
}

function need(me: Me, ...anyOf: string[]) {
  if (!anyOf.some((p) => me.permissions.includes(p))) throw new HttpError(403, NO_PERMISSION);
}

function needAdmin(me: Me, message = NO_PERMISSION) {
  if (me.role !== 'admin') throw new HttpError(403, message);
}

/** Nobody can manage, or give, a role that can do things they can't (Administración can do everything). */
function canHandleRole(me: Me, key: string): boolean {
  if (me.role === 'admin') return true;
  const role = me.roles.get(key);
  return !!role && !role.system && role.permissions.every((p) => DUTIES.includes(p) || me.permissions.includes(p));
}

async function loadEmployee(me: Me, id: unknown) {
  const { data } = await db
    .from('profiles')
    .select(EMPLOYEE_FIELDS)
    .eq('id', String(id))
    .eq('school_id', me.school_id)
    .neq('role', 'admin')
    .maybeSingle();
  if (!data) throw new HttpError(404, 'Empleado no encontrado.');
  if (!canHandleRole(me, data.role)) {
    throw new HttpError(403, 'Esta persona tiene un rol con más permisos que el tuyo. Pídeselo a la cuenta de Administración.');
  }
  return data;
}

async function parseUsername(me: Me, value: unknown, selfId: string | null = null): Promise<string> {
  const username = reqText(value, 100, 'El usuario').toLowerCase();
  if (/\s/.test(username)) throw new HttpError(400, 'El usuario no puede tener espacios.');
  if (username === 'admin') throw new HttpError(400, 'El usuario "admin" está reservado.');
  let q = db.from('profiles').select('id').eq('school_id', me.school_id).eq('username', username);
  if (selfId) q = q.neq('id', selfId);
  const { data } = await q.maybeSingle();
  if (data) throw new HttpError(409, DUPLICATE);
  return username;
}

/** A role of this school that this person may give. Without one, Maestro(a) or the first role. */
function parseRole(me: Me, value: unknown): string {
  const assignable = [...me.roles.values()].filter((r) => !r.system).sort((a, b) => a.position - b.position);
  const key = value ? String(value) : (me.roles.has('teacher') ? 'teacher' : assignable[0]?.key);
  const role = me.roles.get(key || '');
  if (!role || role.system) throw new HttpError(400, 'Rol no válido.');
  if (!canHandleRole(me, role.key)) throw new HttpError(403, 'No puedes dar un rol con más permisos que el tuyo.');
  return role.key;
}

function parsePermissions(value: unknown): string[] {
  const list = Array.isArray(value) ? value.map(String) : [];
  if (list.some((p) => !PERMISSIONS.includes(p))) throw new HttpError(400, 'Permiso no válido.');
  // Managing staff, reports, registering absences and the day's summary need to see everyone's absences.
  if (['staff', 'reports', 'register', 'summary'].some((p) => list.includes(p))) list.push('absences');
  return PERMISSIONS.filter((p) => list.includes(p));
}

/** The room (salón) where the person usually is: "  Salón   204 " → "Salón 204". */
function parseRoom(value: unknown): string | null {
  return optText(value === undefined || value === null ? value : String(value).replace(/\s+/g, ' '), 40, 'El salón');
}

/** Groups the person teaches: the school's own names (Calendario escolar), whatever the case typed. */
async function parseGroups(me: Me, value: unknown): Promise<string[]> {
  const list = Array.isArray(value) ? value.map((g) => String(g).trim().replace(/\s+/g, ' ')).filter(Boolean) : [];
  if (!list.length) return [];
  if (list.length > 50) throw new HttpError(400, 'Una persona puede tener hasta 50 grupos.');
  const { data, error } = await db.from('school_settings').select('groups').eq('school_id', me.school_id).maybeSingle();
  if (error) throw new Error(error.message);
  const school = (data?.groups || []) as string[];
  const byName = new Map(school.map((g) => [g.toLowerCase(), g]));
  return [...new Set(list.map((g) => {
    const found = byName.get(g.toLowerCase());
    if (!found) throw new HttpError(400, `El grupo «${g}» no existe. Créalo primero en Calendario escolar.`);
    return found;
  }))];
}

/** A readable, unique key for a new role: "Enfermería" → "enfermeria", then "enfermeria_2"… */
function roleKey(name: string, taken: Set<string>): string {
  let base = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30)
    .replace(/_+$/, '');
  if (!/^[a-z][a-z0-9_]+$/.test(base)) base = base ? `rol_${base}` : 'rol';
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
  return key;
}

/** Two people creating the same username at once: the second hits a unique constraint instead of our check. */
function isDuplicate(error: { code?: string; message?: string } | null): boolean {
  return !!error && (error.code === 'email_exists' || error.code === '23505' || /already (been )?registered|duplicate/i.test(error.message || ''));
}

function parseDate(value: unknown, label: string): string {
  const s = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
    throw new HttpError(400, `${label} no es una fecha válida.`);
  }
  return s;
}

async function appUrl(): Promise<string> {
  const { data } = await db.from('app_settings').select('value').eq('key', 'app_url').maybeSingle();
  return ((data?.value as { url?: string } | undefined)?.url || '').replace(/\/?$/, '/');
}

async function requireEmailAccount(me: Me) {
  const account = await loadEmailAccount(db, me.school_id);
  if (!account) {
    throw new HttpError(400, 'Primero conecta una cuenta de correo en Escuela y Teams → Correo electrónico.');
  }
  return account;
}

async function recordEmailStatus(me: Me, status: string) {
  await db
    .from('school_settings')
    .update({ email_last_status: (status === 'sent' ? 'ok' : status).slice(0, 300), email_last_at: new Date().toISOString() })
    .eq('school_id', me.school_id);
}

type Template = { welcome_subject: string; welcome_body: string };

/** The access email: the school's editable text in the branded layout. */
function welcomeEmail(me: Me, tpl: Template, person: { full_name: string; username: string }, password: string, url: string, logoSrc: string) {
  const vars = {
    nombre: person.full_name,
    usuario: person.username,
    'contraseña': password,
    contrasena: password,
    escuela: me.school.name,
    codigo: me.school.code,
    enlace: `${url}?escuela=${encodeURIComponent(me.school.code)}`,
  };
  const subject = renderTemplate(tpl.welcome_subject, vars);
  const text = renderTemplate(tpl.welcome_body, vars);
  const html = brandedHtml({
    title: subject,
    text,
    schoolName: me.school.name,
    logoSrc,
    preheader: 'Tu usuario y tu contraseña temporal para entrar a Hallway.',
    highlights: [person.username, password],
    note: 'Este correo incluye una contraseña temporal. Al entrar, la app te pedirá crear la tuya.',
  });
  return { subject, text, html };
}

function messageEmail(me: Me, subject: string, body: string, link: string, logoSrc: string) {
  return {
    subject,
    text: `${body}\n\n— ${me.full_name} · ${me.school.name}\n\nVer en Hallway: ${link}`,
    html: brandedHtml({
      title: subject,
      intro: `De ${me.full_name} · ${me.school.name}`,
      text: body,
      schoolName: me.school.name,
      logoSrc,
      preheader: body.slice(0, 140),
      buttonLabel: 'Abrir enlace',
      cta: { url: link, label: 'Ver en Hallway' },
    }),
  };
}

function check(error: { code?: string; message: string } | null, message = 'No se pudo guardar. Inténtalo de nuevo.') {
  if (error) {
    if (isDuplicate(error)) throw new HttpError(409, DUPLICATE);
    console.error(error);
    throw new HttpError(500, message);
  }
}

const actions: Record<string, (me: Me, b: Record<string, unknown>) => Promise<Response>> = {
  async create_employee(me, b) {
    need(me, 'staff');
    const fullName = reqText(b.full_name, 120, 'El nombre');
    const email = optText(b.email, 200, 'El correo');
    const username = await parseUsername(me, b.username || email);
    const role = parseRole(me, b.role);
    // Everything is checked before the login account exists, so a bad field can't leave it half-created.
    const details = {
      phone: optText(b.phone, 40, 'El teléfono'),
      employee_number: optText(b.employee_number, 40, 'El número de empleado'),
      position: optText(b.position, 120, 'El puesto'),
      room: parseRoom(b.room),
      groups: await parseGroups(me, b.groups),
    };
    const password = validatePassword(b.password ? String(b.password) : generatePassword());

    const { data: created, error } = await db.auth.admin.createUser({
      email: await authEmail(me.school.code, username),
      password,
      email_confirm: true,
      app_metadata: { school_id: me.school_id },
    });
    if (error || !created.user) {
      check(error, 'No se pudo crear la cuenta del empleado.');
      throw new HttpError(500, 'No se pudo crear la cuenta del empleado.');
    }
    const { data: employee, error: insertError } = await db
      .from('profiles')
      .insert({
        id: created.user.id,
        school_id: me.school_id,
        role,
        username,
        full_name: fullName,
        email,
        ...details,
        must_change_password: true,
      })
      .select(EMPLOYEE_FIELDS)
      .single();
    if (insertError) {
      await db.auth.admin.deleteUser(created.user.id);
      check(insertError);
    }
    return json({ employee, temp_password: password }, 201);
  },

  async update_employee(me, b) {
    need(me, 'staff');
    const employee = await loadEmployee(me, b.id);
    const isSelf = employee.id === me.id;
    const next = {
      full_name: 'full_name' in b ? reqText(b.full_name, 120, 'El nombre') : employee.full_name,
      username: 'username' in b ? await parseUsername(me, b.username, employee.id) : employee.username,
      email: 'email' in b ? optText(b.email, 200, 'El correo') : employee.email,
      phone: 'phone' in b ? optText(b.phone, 40, 'El teléfono') : employee.phone,
      employee_number: 'employee_number' in b ? optText(b.employee_number, 40, 'El número de empleado') : employee.employee_number,
      position: 'position' in b ? optText(b.position, 120, 'El puesto') : employee.position,
      room: 'room' in b ? parseRoom(b.room) : employee.room,
      groups: 'groups' in b ? await parseGroups(me, b.groups) : employee.groups,
      role: 'role' in b && b.role !== employee.role ? parseRole(me, b.role) : employee.role,
      active: 'active' in b ? b.active === true || b.active === 'true' : employee.active,
      updated_at: new Date().toISOString(),
    };
    if (isSelf && (next.role !== employee.role || !next.active)) {
      throw new HttpError(400, 'No puedes cambiar tu propio rol ni desactivar tu propia cuenta.');
    }
    const authChanges: Record<string, unknown> = {};
    if (next.username !== employee.username) {
      authChanges.email = await authEmail(me.school.code, next.username);
      authChanges.email_confirm = true;
    }
    // A ban blocks new logins and token refreshes; RLS already hides everything from inactive profiles.
    if (next.active !== employee.active) authChanges.ban_duration = next.active ? 'none' : '876000h';
    if (Object.keys(authChanges).length) {
      const { error } = await db.auth.admin.updateUserById(employee.id, authChanges);
      check(error, 'No se pudo actualizar el acceso del empleado.');
    }
    const { data, error } = await db.from('profiles').update(next).eq('id', employee.id).select(EMPLOYEE_FIELDS).single();
    check(error);
    return json({ employee: data });
  },

  async reset_password(me, b) {
    need(me, 'staff');
    const employee = await loadEmployee(me, b.id);
    const password = validatePassword(b.password ? String(b.password) : generatePassword());
    const { error } = await db.auth.admin.updateUserById(employee.id, { password });
    check(error, 'No se pudo cambiar la contraseña.');
    await db
      .from('profiles')
      .update({ must_change_password: true, password_help_at: null, updated_at: new Date().toISOString() })
      .eq('id', employee.id);
    return json({ temp_password: password });
  },

  /**
   * A new temporary password for everyone active who hasn't signed in yet (ids: some of them), to hand
   * out printed or by Teams when the access emails don't arrive. Only roles this person can manage.
   */
  async reset_never_signed_in(me, b) {
    need(me, 'staff');
    const only = Array.isArray(b.ids) ? new Set(b.ids.map(String)) : null;
    const { data, error } = await db
      .from('profiles')
      .select('id, role, username, full_name, email')
      .eq('school_id', me.school_id)
      .eq('active', true)
      .is('last_login_at', null)
      .neq('role', 'admin')
      .neq('id', me.id)
      .order('full_name');
    check(error);
    const people = (data || []).filter((p) => canHandleRole(me, p.role) && (!only || only.has(p.id)));
    if (people.length > 200) throw new HttpError(400, 'Son demasiadas personas a la vez. Elige menos.');
    const results: Record<string, unknown>[] = [];
    // A few at a time: fast enough for a whole school without hammering Auth.
    for (let i = 0; i < people.length; i += 5) {
      const batch = people.slice(i, i + 5);
      results.push(...(await Promise.all(batch.map(async (p) => {
        const password = generatePassword();
        const { error: authError } = await db.auth.admin.updateUserById(p.id, { password });
        if (authError) return { id: p.id, full_name: p.full_name, username: p.username, error: 'No se pudo cambiar la contraseña.' };
        await db
          .from('profiles')
          .update({ must_change_password: true, password_help_at: null, updated_at: new Date().toISOString() })
          .eq('id', p.id);
        return { id: p.id, full_name: p.full_name, username: p.username, role: p.role, email: p.email, password };
      }))));
    }
    return json({ people: results });
  },

  async delete_employee(me, b) {
    need(me, 'staff');
    const employee = await loadEmployee(me, b.id);
    if (employee.id === me.id) throw new HttpError(400, 'No puedes eliminar tu propia cuenta.');
    const { count } = await db.from('absences').select('id', { count: 'exact', head: true }).eq('user_id', employee.id);
    if (count) {
      throw new HttpError(
        409,
        'Este empleado tiene ausencias registradas. Desactívalo en lugar de eliminarlo para conservar el historial.',
      );
    }
    const { error } = await db.auth.admin.deleteUser(employee.id);
    check(error, 'No se pudo eliminar el empleado.');
    return json({ ok: true });
  },

  async set_admin_password(me, b) {
    need(me, 'settings');
    const next = validatePassword(b.new_password);
    const { data: admin } = await db
      .from('profiles')
      .select('id')
      .eq('school_id', me.school_id)
      .eq('role', 'admin')
      .maybeSingle();
    if (!admin) throw new HttpError(404, 'No se encontró la cuenta de administración.');
    const client = anonClient();
    const { error: loginError } = await client.auth.signInWithPassword({
      email: await authEmail(me.school.code, 'admin'),
      password: String(b.current_password || ''),
    });
    if (loginError) throw new HttpError(400, 'La contraseña de administración actual no es correcta.');
    await client.auth.signOut();
    const { error } = await db.auth.admin.updateUserById(admin.id, { password: next });
    check(error, 'No se pudo cambiar la contraseña.');
    return json({ ok: true });
  },

  async test_teams(me, b) {
    need(me, 'settings');
    const passwordChannel = b.target === 'password';
    const { data: settings } = await db.from('school_settings').select('*').eq('school_id', me.school_id).maybeSingle();
    const url = passwordChannel ? settings?.teams_password_webhook_url : settings?.teams_webhook_url;
    if (!url) throw new HttpError(400, 'Primero guarda la URL del webhook de Teams.');
    if (!settings.teams_enabled) throw new HttpError(400, 'Las notificaciones de Teams están desactivadas.');
    const { data: app } = await db.from('app_settings').select('value').eq('key', 'app_url').maybeSingle();
    const what = passwordChannel ? 'Las solicitudes de contraseña olvidada' : 'Las nuevas ausencias del personal';
    let status = 'ok';
    try {
      await postToTeams(
        url,
        buildCard({
          title: '✅ Prueba de Hallway',
          subtitle: me.school.name,
          text: `${what} se publicarán en este canal. Prueba enviada por ${me.full_name}.`,
          linkUrl: (app?.value as { url?: string } | undefined)?.url,
        }),
      );
    } catch (err) {
      status = `error: ${(err as Error).message}`.slice(0, 300);
    }
    if (!passwordChannel) {
      await db
        .from('school_settings')
        .update({ teams_last_status: status, teams_last_at: new Date().toISOString() })
        .eq('school_id', me.school_id);
    }
    if (status !== 'ok') throw new HttpError(502, `No se pudo enviar a Teams: ${status.replace(/^error: /, '')}`);
    return json({ ok: true });
  },

  /** Emails the username and the temporary password that was just created or reset. */
  async send_credentials(me, b) {
    need(me, 'staff');
    const employee = await loadEmployee(me, b.id);
    if (!isEmail(employee.email)) throw new HttpError(400, 'Este empleado no tiene un correo válido. Añádelo en su ficha.');
    const password = String(b.password || '');
    const account = await requireEmailAccount(me);
    // Only a password that really works is sent: the one shown right after creating or resetting it.
    const { data: matches, error: matchError } = await db.rpc('temp_password_matches', {
      p_user: employee.id,
      p_password: password,
    });
    check(matchError, 'No se pudo comprobar la contraseña.');
    if (!matches) {
      throw new HttpError(400, 'Esa contraseña ya no es válida. Usa «Restablecer contraseña» para generar una nueva.');
    }
    const { data: tpl } = await db
      .from('school_settings')
      .select('welcome_subject, welcome_body')
      .eq('school_id', me.school_id)
      .single();
    const url = await appUrl();
    const branding = await loadBranding(url, schoolIconUrl({ id: me.school_id, icon_version: me.school.icon_version }));
    const email = welcomeEmail(me, tpl as Template, employee, password, url, branding.logoSrc);
    const [status] = await sendEmails(
      account,
      [{ ...email, to: employee.email, toName: employee.full_name, replyTo: isEmail(me.email) ? me.email : null }],
      branding,
    );
    await recordEmailStatus(me, status);
    if (status !== 'sent') throw new HttpError(502, `No se pudo enviar el correo: ${status.replace(/^error: /, '')}`);
    return json({ ok: true, to: employee.email });
  },

  /** A message to everyone, a role or specific people: in-app notice + push, and optionally email. */
  async send_message(me, b) {
    need(me, 'messages');
    const subject = reqText(b.subject, 150, 'El asunto').replace(/[\r\n]+/g, ' ');
    const body = reqText(b.body, 5000, 'El mensaje');
    const wantEmail = b.email === true;

    const { count: lastHour } = await db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('school_id', me.school_id)
      .gte('created_at', new Date(Date.now() - 3_600_000).toISOString());
    if ((lastHour ?? 0) >= 20) throw new HttpError(429, 'Se enviaron muchos mensajes en la última hora. Espera un poco.');

    let q = db
      .from('profiles')
      .select('id, full_name, email')
      .eq('school_id', me.school_id)
      .eq('active', true)
      .neq('role', 'admin')
      .neq('id', me.id);
    // Everyone, the people with one role, or specific people.
    const group = typeof b.to === 'string' ? me.roles.get(b.to) : undefined;
    if (Array.isArray(b.to)) {
      const ids = b.to.map(String).filter((id) => UUID_RE.test(id)).slice(0, 500);
      if (!ids.length) throw new HttpError(400, 'Elige al menos una persona.');
      q = q.in('id', ids);
    } else if (group && !group.system) {
      q = q.eq('role', group.key);
    } else if (b.to !== 'all') {
      throw new HttpError(400, 'Elige a quién enviar el mensaje.');
    }
    const { data: people, error } = await q.order('full_name');
    check(error, 'No se pudo leer el personal.');
    if (!people?.length) throw new HttpError(400, 'No hay personas activas en ese grupo.');
    const audience = Array.isArray(b.to)
      ? people.length <= 3 ? people.map((p) => p.full_name).join(', ') : `${people.length} personas`
      : group?.name || 'Todo el personal';
    // Fail before saving anything if email was asked for but isn't set up.
    const account = wantEmail ? await requireEmailAccount(me) : null;

    const { data: message, error: messageError } = await db
      .from('messages')
      .insert({
        school_id: me.school_id,
        sender_id: me.id,
        sender_name: me.full_name,
        subject,
        body,
        audience,
        recipients: people.length,
        email_requested: wantEmail,
      })
      .select('id')
      .single();
    check(messageError, 'No se pudo guardar el mensaje.');
    const id = message!.id as number;
    const rows = people.map((p) => ({
      message_id: id,
      user_id: p.id,
      school_id: me.school_id,
      email_status: wantEmail && !isEmail(p.email) ? 'no_email' : null,
    }));
    check((await db.from('message_recipients').insert(rows)).error, 'No se pudo guardar el mensaje.');
    const preview = body.length > 140 ? `${body.slice(0, 137)}…` : body;
    // Each notification also goes out as a push (database trigger).
    check(
      (await db.from('notifications').insert(
        people.map((p) => ({ user_id: p.id, title: subject, body: `${me.full_name}: ${preview}`, link: `#/message/${id}` })),
      )).error,
      'No se pudieron crear los avisos.',
    );

    let emailed = 0;
    let failed = 0;
    const withEmail = people.filter((p) => isEmail(p.email));
    if (account && withEmail.length) {
      const url = await appUrl();
      const branding = await loadBranding(url, schoolIconUrl({ id: me.school_id, icon_version: me.school.icon_version }));
      const email = messageEmail(me, subject, body, `${url}#/message/${id}`, branding.logoSrc);
      const results = await sendEmails(
        account,
        withEmail.map((p) => ({ ...email, to: p.email!, toName: p.full_name, replyTo: isEmail(me.email) ? me.email : null })),
        branding,
      );
      const statusById = new Map(withEmail.map((p, i) => [p.id, results[i]]));
      emailed = results.filter((r) => r === 'sent').length;
      failed = results.length - emailed;
      await db
        .from('message_recipients')
        .upsert(rows.map((r) => ({ ...r, email_status: statusById.get(r.user_id) ?? r.email_status })));
      await db.from('messages').update({ emailed, email_failed: failed }).eq('id', id);
      await recordEmailStatus(me, results.find((r) => r !== 'sent') ?? 'sent');
    }
    return json({ id, recipients: people.length, emailed, email_failed: failed, no_email: wantEmail ? people.length - withEmail.length : 0 });
  },

  /** Sends a test email to the school's own address. */
  async test_email(me) {
    need(me, 'settings');
    const account = await requireEmailAccount(me);
    const url = await appUrl();
    const branding = await loadBranding(url, schoolIconUrl({ id: me.school_id, icon_version: me.school.icon_version }));
    const text =
      `Este es un correo de prueba de ${me.school.name}.\n\nSi lo recibiste, el correo está bien configurado: ` +
      `la app ya puede enviar los accesos del personal y tus mensajes.\n\nEnviado por ${me.full_name}.`;
    const [status] = await sendEmails(account, [{
      to: account.from_email,
      subject: 'Prueba de Hallway',
      text,
      html: brandedHtml({
        title: 'El correo funciona ✅',
        text,
        schoolName: me.school.name,
        logoSrc: branding.logoSrc,
        preheader: 'El correo de la escuela está bien configurado.',
        cta: { url, label: 'Abrir Hallway' },
      }),
    }], branding);
    await recordEmailStatus(me, status);
    if (status !== 'sent') throw new HttpError(502, status.replace(/^error: /, ''));
    return json({ ok: true, to: account.from_email });
  },

  /**
   * New school code. Every login is "code + username", so all the school's accounts move to the new
   * code (all or nothing), the old code is kept so old links keep working, and everyone is told.
   */
  async change_school_code(me, b) {
    needAdmin(me, 'Solo la cuenta de Administración puede cambiar el código.');
    const code = String(b.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]{2,19}$/.test(code)) {
      throw new HttpError(400, 'El código debe tener de 3 a 20 letras (sin acentos), números o guiones, sin espacios.');
    }
    const oldCode = me.school.code;
    if (code === oldCode) throw new HttpError(400, 'Ese ya es el código de la escuela.');
    const [{ data: other }, { data: usedBefore }] = await Promise.all([
      db.from('schools').select('id').eq('code', code).maybeSingle(),
      db.from('school_code_history').select('school_id').eq('code', code).neq('school_id', me.school_id).maybeSingle(),
    ]);
    if (other || usedBefore) throw new HttpError(409, 'Ese código ya lo usa otra escuela. Elige otro.');

    const { data: people, error } = await db
      .from('profiles')
      .select('id, role, username, full_name, email, active')
      .eq('school_id', me.school_id);
    check(error, 'No se pudo leer el personal.');
    const moveTo = async (c: string, list: typeof people) => {
      const failed: string[] = [];
      for (const p of list!) {
        const { error: e } = await db.auth.admin.updateUserById(p.id, { email: await authEmail(c, p.username), email_confirm: true });
        if (e) failed.push(p.id);
      }
      return failed;
    };
    const moved: NonNullable<typeof people> = [];
    for (const p of people!) {
      const { error: e } = await db.auth.admin.updateUserById(p.id, { email: await authEmail(code, p.username), email_confirm: true });
      if (e) {
        console.error('change_school_code', p.id, e);
        const stuck = await moveTo(oldCode, moved);
        if (stuck.length) console.error('change_school_code rollback failed for', stuck);
        throw new HttpError(500, 'No se pudo cambiar el código. No se cambió nada; inténtalo de nuevo.');
      }
      moved.push(p);
    }
    const { error: updateError } = await db.from('schools').update({ code }).eq('id', me.school_id);
    if (updateError) {
      await moveTo(oldCode, moved);
      if (isDuplicate(updateError)) throw new HttpError(409, 'Ese código ya lo usa otra escuela. Elige otro.');
      check(updateError, 'No se pudo cambiar el código.');
    }
    await db.from('school_code_history').delete().eq('code', code).eq('school_id', me.school_id);
    await db.from('school_code_history').upsert({ code: oldCode, school_id: me.school_id, changed_at: new Date().toISOString() });

    // Everyone has to know: in-app notice + push, and an email when the school has one connected.
    const staff = people!.filter((p) => p.active && p.role !== 'admin' && p.id !== me.id);
    if (staff.length) {
      await db.from('notifications').insert(staff.map((p) => ({
        user_id: p.id,
        title: `Nuevo código de escuela: ${code}`,
        body: `Tu usuario y tu contraseña no cambian. Si la app te pide el código, escribe ${code}.`,
        link: '#/notifications',
      })));
    }
    let emailed = 0;
    let failed = 0;
    const account = await loadEmailAccount(db, me.school_id);
    const withEmail = staff.filter((p) => isEmail(p.email));
    if (account && withEmail.length) {
      const url = await appUrl();
      const link = `${url}?escuela=${encodeURIComponent(code)}`;
      const branding = await loadBranding(url, schoolIconUrl({ id: me.school_id, icon_version: me.school.icon_version }));
      const subject = `Nuevo código de ${me.school.name}: ${code}`;
      const results = await sendEmails(
        account,
        withEmail.map((p) => {
          const text = `Hola ${p.full_name}:\n\n${me.school.name} tiene un nuevo código para entrar a Hallway.\n\n` +
            `   Código de escuela: ${code}\n   Tu usuario: ${p.username}\n\n` +
            'Tu usuario y tu contraseña siguen siendo los mismos. Si ya tienes la sesión abierta, no tienes que hacer nada.\n\n' +
            `Si la app te pide el código, escribe el nuevo o entra con este enlace, que ya lo trae puesto:\n${link}`;
          return {
            to: p.email!,
            toName: p.full_name,
            replyTo: isEmail(me.email) ? me.email : null,
            subject,
            text,
            html: brandedHtml({
              title: 'Cambió el código de la escuela',
              text,
              schoolName: me.school.name,
              logoSrc: branding.logoSrc,
              preheader: `El nuevo código para entrar es ${code}. Tu usuario y contraseña no cambian.`,
              highlights: [code, p.username],
            }),
          };
        }),
        branding,
      );
      emailed = results.filter((r) => r === 'sent').length;
      failed = results.length - emailed;
      await recordEmailStatus(me, results.find((r) => r !== 'sent') ?? 'sent');
    }
    return json({ code, notified: staff.length, emailed, email_failed: failed, no_email: account ? staff.length - withEmail.length : staff.length });
  },

  /** How an email will look, with sample data, for the preview in the app (logo as cid:leap-logo). */
  async preview_email(me, b) {
    need(me, ...(b.kind === 'message' ? ['messages'] : ['staff', 'settings']));
    const url = await appUrl();
    const logoSrc = `cid:${LOGO_CID}`;
    if (b.kind === 'message') {
      const subject = reqText(b.subject, 150, 'El asunto').replace(/[\r\n]+/g, ' ');
      const body = reqText(b.body, 5000, 'El mensaje');
      const email = messageEmail(me, subject, body, `${url}#/messages`, logoSrc);
      return json({ subject: email.subject, html: email.html });
    }
    const { data: saved } = await db
      .from('school_settings')
      .select('welcome_subject, welcome_body')
      .eq('school_id', me.school_id)
      .single();
    const tpl: Template = {
      welcome_subject: optText(b.subject, 200, 'El asunto') ?? saved!.welcome_subject,
      welcome_body: optText(b.body, 5000, 'El mensaje') ?? saved!.welcome_body,
    };
    const email = welcomeEmail(me, tpl, { full_name: 'María González', username: 'maria.gonzalez' }, 'Kp7mWq2xTz', url, logoSrc);
    return json({ subject: email.subject, html: email.html });
  },

  /** Creates (no key) or changes a role: its name, what it can do and whether its absences need coverage. */
  async save_role(me, b) {
    needAdmin(me, 'Solo la cuenta de Administración puede administrar los roles.');
    const name = reqText(b.name, 40, 'El nombre del rol').replace(/\s+/g, ' ');
    const permissions = parsePermissions(b.permissions);
    const coverage = b.coverage !== false;
    // Whether people with this role report their own absences (yes unless turned off).
    const ownAbsences = b.own_absences !== false;
    const key = b.key ? String(b.key) : null;
    const roles = [...me.roles.values()];
    if (roles.some((r) => r.name.toLowerCase() === name.toLowerCase() && r.key !== key)) {
      throw new HttpError(409, 'Ya existe un rol con ese nombre.');
    }
    let saved;
    if (key) {
      const role = me.roles.get(key);
      if (!role || role.system) throw new HttpError(404, 'No se encontró el rol.');
      saved = await db
        .from('school_roles')
        .update({ name, permissions, coverage, own_absences: ownAbsences })
        .eq('school_id', me.school_id)
        .eq('key', key)
        .select('key, name, permissions, coverage, own_absences')
        .single();
    } else {
      saved = await db
        .from('school_roles')
        .insert({
          school_id: me.school_id,
          key: roleKey(name, new Set(me.roles.keys())),
          name,
          permissions,
          coverage,
          own_absences: ownAbsences,
          position: Math.max(0, ...roles.map((r) => r.position)) + 10,
        })
        .select('key, name, permissions, coverage, own_absences')
        .single();
    }
    if (saved.error?.code === '23505') throw new HttpError(409, 'Ya existe un rol con ese nombre.');
    check(saved.error, 'No se pudo guardar el rol.');
    return json({ role: saved.data }, key ? 200 : 201);
  },

  /** Deletes a role nobody has (people are moved to another role first). */
  async delete_role(me, b) {
    needAdmin(me, 'Solo la cuenta de Administración puede administrar los roles.');
    const role = me.roles.get(String(b.key || ''));
    if (!role || role.system) throw new HttpError(404, 'No se encontró el rol.');
    const inUse = (n: number) =>
      new HttpError(409, `Hay ${n} persona(s) con este rol (contando las desactivadas). Cámbiales el rol antes de borrarlo.`);
    const { count } = await db
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('school_id', me.school_id)
      .eq('role', role.key);
    if (count) throw inUse(count);
    if ([...me.roles.values()].filter((r) => !r.system).length <= 1) throw new HttpError(400, 'Debe quedar al menos un rol.');
    const { error } = await db.from('school_roles').delete().eq('school_id', me.school_id).eq('key', role.key);
    // Someone got this role in the meantime.
    if (error?.code === '23503') throw inUse(1);
    check(error, 'No se pudo borrar el rol.');
    return json({ ok: true });
  },

  /** Removes a day or period without classes from the school calendar. */
  async delete_closure(me, b) {
    need(me, 'calendar');
    const id = Number(b.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, 'Solicitud no válida.');
    const { data, error } = await db
      .from('school_closures')
      .delete()
      .eq('id', id)
      .eq('school_id', me.school_id)
      .select('id');
    check(error, 'No se pudo borrar el día.');
    if (!data?.length) throw new HttpError(404, 'No se encontró ese día en el calendario.');
    return json({ ok: true });
  },

  /**
   * After downloading the Excel archive, the school deletes a finished period to free space.
   * Only received and cancelled absences go; pending ones stay until someone handles them.
   */
  async archive_purge(me, b) {
    needAdmin(me, 'Solo la cuenta de Administración puede liberar espacio.');
    if (b.confirm !== 'BORRAR') throw new HttpError(400, 'Escribe BORRAR para confirmar.');
    const from = parseDate(b.from, 'La fecha inicial');
    const to = parseDate(b.to, 'La fecha final');
    const today = new Date().toISOString().slice(0, 10);
    if (from > to) throw new HttpError(400, 'La fecha inicial debe ser antes de la final.');
    if (to >= today) throw new HttpError(400, 'Solo se pueden borrar períodos que ya terminaron.');
    // Same rule as the Excel archive: an absence belongs to the period in which it starts.
    const ids: number[] = [];
    for (let page = 0; ; page++) {
      const { data, error } = await db
        .from('absences')
        .select('id')
        .eq('school_id', me.school_id)
        .in('status', ['received', 'cancelled'])
        .gte('start_date', from)
        .lte('start_date', to)
        .lt('end_date', today)
        .order('id')
        .range(page * 1000, page * 1000 + 999);
      check(error, 'No se pudieron leer las ausencias.');
      ids.push(...(data || []).map((r) => r.id as number));
      if (!data || data.length < 1000) break;
    }
    if (!ids.length) throw new HttpError(400, 'No hay ausencias recibidas o canceladas en ese período.');
    let removed;
    try {
      removed = await deleteAbsences(db, ids);
    } catch (err) {
      console.error(err);
      throw new HttpError(500, 'No se pudo terminar de liberar el espacio. Inténtalo de nuevo.');
    }
    await db.from('archive_runs').insert({
      school_id: me.school_id,
      date_from: from,
      date_to: to,
      ...removed,
      actor_id: me.id,
      actor_name: me.full_name,
    });
    return json(removed);
  },

  /**
   * At the end of the school year a service (Enfermería, Trabajo Social…) downloads its history and closes it:
   * the finished turns of the period are deleted; open ones stay. Only whoever attends the service (or the
   * Administración account) can do it. from_ts / to_ts: the period's start and end on the phone's clock.
   */
  async close_service_year(me, b) {
    if (b.confirm !== 'BORRAR') throw new HttpError(400, 'Escribe BORRAR para confirmar.');
    const from = Date.parse(String(b.from_ts || ''));
    const to = Date.parse(String(b.to_ts || ''));
    if (Number.isNaN(from) || Number.isNaN(to) || from >= to) throw new HttpError(400, 'El período no es válido.');
    if (to > Date.now()) throw new HttpError(400, 'Solo se puede cerrar un período que ya terminó.');
    const { data: service, error } = await db
      .from('school_services')
      .select('id, name, roles')
      .eq('id', Number(b.service_id) || 0)
      .eq('school_id', me.school_id)
      .maybeSingle();
    check(error, 'No se pudo leer el servicio.');
    if (!service) throw new HttpError(404, 'No se encontró el servicio.');
    if (me.role !== 'admin' && !(service.roles as string[]).includes(me.role)) {
      throw new HttpError(403, 'Solo quien atiende el servicio puede cerrar su historial.');
    }
    const { error: deleteError, count } = await db
      .from('service_requests')
      .delete({ count: 'exact' })
      .eq('service_id', service.id)
      .eq('school_id', me.school_id)
      .in('status', ['done', 'cancelled'])
      .gte('created_at', new Date(from).toISOString())
      .lt('created_at', new Date(to).toISOString());
    check(deleteError, 'No se pudo borrar el historial. Inténtalo de nuevo.');
    return json({ removed: count ?? 0 });
  },
};

/** Actions for roles without permissions (Enfermería, Trabajo Social…): they check who may use them. */
const SERVICE_ACTIONS = ['close_service_year'];

serve(async (req) => {
  const me = await currentUser(req);
  const body = await readJson(req);
  const name = String(body.action);
  const action = actions[name];
  if (!action) throw new HttpError(400, 'Acción no válida.');
  if (!me.permissions.length && !SERVICE_ACTIONS.includes(name)) throw new HttpError(403, NO_PERMISSION);
  return action(me, body);
});
