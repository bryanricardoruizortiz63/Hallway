// Several accounts on one phone (e.g. the school's Administración and your own IT account): switch without signing
// out and in again. Each keeps its own session (its refresh token is saved here). With more than one saved, each
// account asks once a day for the code of an authenticator app (Google or Microsoft Authenticator): Supabase MFA, TOTP.
import { sb, signIn } from './backend.js';
import { roleLabel } from './lib.js';

const KEY = 'lah:accounts';

function read() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function write(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* private mode: the switcher just won't remember */
  }
}

/** [{ id, name, school, role, refresh }] in the order they were added. */
export const savedAccounts = () => read();

/** Saves (or updates) the open account with its current session. */
async function remember(me) {
  const { data } = await sb.auth.getSession();
  const s = data.session;
  if (!s || !me) return;
  const entry = { id: s.user.id, name: me.user.full_name, school: me.school.name, role: roleLabel(me.user.role), refresh: s.refresh_token };
  const list = read();
  const i = list.findIndex((a) => a.id === entry.id);
  if (i >= 0) list[i] = entry;
  else list.push(entry);
  write(list);
}

/** Forgets an account on this phone (its session stays valid elsewhere). */
export function forgetAccount(id) {
  write(read().filter((a) => a.id !== id));
}

// The refresh token changes every hour: keep the saved one current for the open account.
sb.auth.onAuthStateChange((event, session) => {
  if (!session) return;
  const list = read();
  const a = list.find((x) => x.id === session.user.id);
  if (a && a.refresh !== session.refresh_token) {
    a.refresh = session.refresh_token;
    write(list);
  }
});

/** Opens the app again (at link, or from the start) as whichever account is signed in now. */
function restart(link = '#/') {
  location.hash = link;
  location.reload();
}

/** Switches to a saved account (and opens link there). The page reloads; the daily code is asked there if needed. */
export async function switchAccount(id, me, link) {
  await remember(me);
  const target = read().find((a) => a.id === id);
  if (!target) throw new Error('No se encontró esa cuenta en este teléfono.');
  const previous = read().find((a) => a.id === me?.user.id);
  const { data, error } = await sb.auth.refreshSession({ refresh_token: target.refresh });
  if (error || !data.session) {
    forgetAccount(id);
    if (previous) await sb.auth.refreshSession({ refresh_token: previous.refresh }).catch(() => {});
    throw new Error(`La sesión de ${target.name} venció. Agrégala otra vez con su usuario y contraseña.`);
  }
  restart(link);
}

/** The saved account a notice belongs to, when it isn't the open one (null otherwise). */
export function otherAccount(uid, me) {
  if (!uid || !me || uid === me.user.id) return null;
  return read().find((a) => a.id === uid) || null;
}

/**
 * A notice of the other account opened the app (?as=<user id>): start as that account. Before anything loads, so
 * the app opens directly where the notice points.
 */
export async function adoptAccountFromUrl() {
  const url = new URL(location.href);
  const uid = url.searchParams.get('as');
  if (!uid) return;
  url.searchParams.delete('as');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
  const { data } = await sb.auth.getSession();
  const current = data.session;
  if (!current || current.user.id === uid) return;
  const list = read();
  const target = list.find((a) => a.id === uid);
  const mine = list.find((a) => a.id === current.user.id);
  if (!target || !mine) return;
  mine.refresh = current.refresh_token;
  write(list);
  const { error } = await sb.auth.refreshSession({ refresh_token: target.refresh });
  if (error) await sb.auth.refreshSession({ refresh_token: mine.refresh }).catch(() => {});
}

/** Signs in to one more account, keeping the open one. */
export async function addAccount(me, schoolCode, username, password) {
  await remember(me);
  const previous = read().find((a) => a.id === me.user.id);
  let added;
  try {
    added = await signIn(schoolCode, username, password);
  } catch (err) {
    if (previous) await sb.auth.refreshSession({ refresh_token: previous.refresh }).catch(() => {});
    throw err;
  }
  if (added.user.id === me.user.id) throw new Error('Esa es la cuenta que ya tienes abierta.');
  await remember(added);
  restart();
}

/** After signing out of the open account: the next saved one, if any (it reloads), or false. */
export async function afterSignOut(id) {
  forgetAccount(id);
  const next = read()[0];
  if (!next) return false;
  const { data, error } = await sb.auth.refreshSession({ refresh_token: next.refresh });
  if (error || !data.session) {
    forgetAccount(next.id);
    return false;
  }
  restart();
  return true;
}

// ---- The daily code ------------------------------------------------------------------------------

/** When the open session last passed the authenticator code (seconds), from the signed token. */
function codeTime(session) {
  try {
    const part = session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(part + '='.repeat((4 - (part.length % 4)) % 4)));
    return (claims.amr || []).find((m) => m.method === 'totp')?.timestamp || null;
  } catch {
    return null;
  }
}

/** With two or more accounts on this phone, the open one must have passed the code today. */
export async function needsDailyCode(me) {
  if (!me || read().length < 2) return false;
  const { data } = await sb.auth.getSession();
  if (!data.session) return false;
  const t = codeTime(data.session);
  return !t || new Date(t * 1000).toDateString() !== new Date().toDateString();
}

/** The account's authenticator, or null when it doesn't have one yet. */
export async function authenticator() {
  const { data, error } = await sb.auth.mfa.listFactors();
  if (error) throw new Error('No se pudo revisar la verificación. Revisa tu internet.');
  return data.totp.find((f) => f.status === 'verified') || null;
}

/** A new authenticator to scan: { factorId, qr (an image), secret (to type it by hand) }. */
export async function startAuthenticator() {
  const { data: factors } = await sb.auth.mfa.listFactors();
  // A previous attempt that was never confirmed.
  for (const f of factors?.all || []) {
    if (f.factor_type === 'totp' && f.status !== 'verified') await sb.auth.mfa.unenroll({ factorId: f.id }).catch(() => {});
  }
  const { data, error } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Hallway', issuer: 'Hallway' });
  if (error) throw new Error('No se pudo preparar la verificación. Habla con la dirección para que la active en Supabase.');
  return { factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret };
}

/** Checks the 6-digit code; the session then counts as verified today. */
export async function checkCode(factorId, code) {
  const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code: String(code).replace(/\s+/g, '') });
  if (error) {
    throw new Error(/invalid|verification/i.test(`${error.code} ${error.message}`)
      ? 'Ese código no es correcto o ya cambió. Escribe el que sale ahora en la app.'
      : 'No se pudo verificar. Revisa tu internet e inténtalo de nuevo.');
  }
}
