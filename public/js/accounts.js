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

/**
 * [{ id, name, school, role, code, username, refresh, expired }] in the order they were added. expired: Supabase
 * closed its session (for example, when the same account set up or passed the two-step code on another device while
 * this one hadn't yet): it stays here and opens again with its password once, then the daily code.
 */
export const savedAccounts = () => read();

/** Saves (or updates) the open account with its current session. */
async function remember(me) {
  const { data } = await sb.auth.getSession();
  const s = data.session;
  if (!s || !me) return;
  const entry = {
    id: s.user.id, name: me.user.full_name, school: me.school.name, role: roleLabel(me.user.role),
    code: me.school.code, username: me.user.username, refresh: s.refresh_token,
  };
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

/** Its session was closed: keep it on the list (name, school, user) so it opens again with only the password. */
function markExpired(id) {
  const list = read();
  const a = list.find((x) => x.id === id);
  if (a) {
    a.expired = true;
    a.refresh = null;
    write(list);
  }
}

/** Supabase answered that the saved session no longer exists (not a network problem). */
const sessionGone = (error) => !!error && error.status >= 400 && error.status < 500;

/** Where an account whose session was closed opens again (its password, prefilled school and user). */
export const reopenLink = (id) => `#/accounts/add?cuenta=${encodeURIComponent(id)}`;

// The refresh token changes every hour: keep the saved one current for the open account.
sb.auth.onAuthStateChange((event, session) => {
  if (!session) return;
  const list = read();
  const a = list.find((x) => x.id === session.user.id);
  if (a && (a.refresh !== session.refresh_token || a.expired)) {
    a.refresh = session.refresh_token;
    delete a.expired;
    write(list);
  }
});

// Where we came from before switching or adding: «Cancelar» on the code screen goes back there.
const BACK = 'lah:came-from';

function cameFrom(value) {
  try {
    if (value === undefined) return JSON.parse(sessionStorage.getItem(BACK) || 'null');
    if (value === null) sessionStorage.removeItem(BACK);
    else sessionStorage.setItem(BACK, JSON.stringify(value));
  } catch {
    /* private mode */
  }
  return null;
}

/** The code was given: nothing to go back to. */
export const codeGiven = () => cameFrom(null);

/**
 * «Cancelar» on the code screen: back to the account we came from (an account just added is forgotten again).
 * False when there is nowhere to go back to (the caller signs out).
 */
export async function cancelCode(me) {
  const back = cameFrom();
  cameFrom(null);
  const previous = back && read().find((a) => a.id === back.from && a.id !== me.user.id);
  if (!previous || previous.expired) return false;
  if (back.added === me.user.id) forgetAccount(me.user.id);
  const { error } = await sb.auth.refreshSession({ refresh_token: previous.refresh });
  if (error) {
    if (sessionGone(error)) markExpired(previous.id);
    return false;
  }
  restart();
  return true;
}

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
  // Its session was closed: its password once (school and user already filled in), then the daily code.
  if (target.expired) {
    location.hash = reopenLink(id);
    return;
  }
  const previous = read().find((a) => a.id === me?.user.id);
  cameFrom({ from: me?.user.id });
  const { data, error } = await sb.auth.refreshSession({ refresh_token: target.refresh });
  if (error || !data.session) {
    cameFrom(null);
    if (previous) await sb.auth.refreshSession({ refresh_token: previous.refresh }).catch(() => {});
    if (!sessionGone(error)) throw new Error('No se pudo cambiar de cuenta. Revisa tu internet e inténtalo de nuevo.');
    markExpired(id);
    location.hash = reopenLink(id);
    return;
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
  if (target.expired) return;
  const { error } = await sb.auth.refreshSession({ refresh_token: target.refresh });
  if (error) {
    if (sessionGone(error)) markExpired(target.id);
    await sb.auth.refreshSession({ refresh_token: mine.refresh }).catch(() => {});
  }
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
  // Opening again one that was already here (its session had been closed): «Cancelar» doesn't forget it.
  const known = read().some((a) => a.id === added.user.id);
  await remember(added);
  cameFrom({ from: me.user.id, added: known ? null : added.user.id });
  restart();
}

/** After signing out of the open account: the next saved one, if any (it reloads), or false. */
export async function afterSignOut(id) {
  forgetAccount(id);
  for (const next of read().filter((a) => !a.expired)) {
    const { data, error } = await sb.auth.refreshSession({ refresh_token: next.refresh });
    if (!error && data.session) {
      restart();
      return true;
    }
    if (sessionGone(error)) markExpired(next.id);
  }
  return false;
}

// ---- The daily code ------------------------------------------------------------------------------

const SECOND_STEP = new Set(['totp', 'webauthn', 'mfa/totp', 'mfa/webauthn']);

/** When the open session last passed the authenticator code (seconds), from the signed token. */
function codeTime(session) {
  try {
    const part = session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(part + '='.repeat((4 - (part.length % 4)) % 4)));
    // The code of the authenticator app or a passkey: either one is the second step.
    return (claims.amr || []).filter((m) => SECOND_STEP.has(m.method)).reduce((t, m) => Math.max(t, m.timestamp || 0), 0) || null;
  } catch {
    return null;
  }
}

/** The open account must have passed the code today (two accounts on this phone, or turned on for this person). */
export async function needsDailyCode(me) {
  if (!me) return false;
  // Two accounts on this phone, or the dirección turned the code on for this person.
  if (read().length < 2 && !(await sb.rpc('mfa_required')).data) return false;
  const { data } = await sb.auth.getSession();
  if (!data.session) return false;
  const t = codeTime(data.session);
  return !t || new Date(t * 1000).toDateString() !== new Date().toDateString();
}

// ---- Passkeys (Face ID, huella o el PIN del equipo) as the second step -----------------------------

/** Passkeys belong to the app's address: Supabase is set up for this one (Authentication › Passkeys). */
export const PASSKEY_HOST = 'app.hallwayedu.com';
const webauthn = () => ({ rpId: PASSKEY_HOST, rpOrigins: [`https://${PASSKEY_HOST}`] });

/** True where a passkey can be used: the app's address, in a browser that has them. */
export const passkeysHere = () => location.hostname === PASSKEY_HOST && typeof window.PublicKeyCredential === 'function';

/** The ways this account can pass the second step: { totp: factor|null, passkeys: [factor] } (only confirmed ones). */
export async function secondSteps() {
  const { data, error } = await sb.auth.mfa.listFactors();
  if (error) throw new Error('No se pudo revisar la verificación. Revisa tu internet.');
  const all = data.all || [];
  return {
    totp: all.find((f) => f.factor_type === 'totp' && f.status === 'verified') || null,
    passkeys: all.filter((f) => f.factor_type === 'webauthn' && f.status === 'verified'),
  };
}

// On this phone: which passkey was made here and which way was used last (per account).
const localKey = (kind, userId) => `lah:${kind}:${userId}`;
function local(kind, userId, value) {
  try {
    if (value === undefined) return localStorage.getItem(localKey(kind, userId));
    if (value === null) localStorage.removeItem(localKey(kind, userId));
    else localStorage.setItem(localKey(kind, userId), value);
  } catch {
    /* private mode */
  }
  return null;
}
/** 'passkey' or 'code': the way this account used last on this phone. */
export const lastStep = (userId) => local('mfa-way', userId);
export const rememberStep = (userId, way) => local('mfa-way', userId, way);
/** The passkey made on this phone, if it's one of the account's. */
export const passkeyHere = (userId, passkeys) => passkeys.find((f) => f.id === local('passkey', userId)) || null;

/** What went wrong with a passkey, in words. */
function passkeyError(error) {
  const text = `${error?.name || ''} ${error?.code || ''} ${error?.message || ''} ${error?.originalError?.name || ''}`;
  if (/NotAllowed|abort|cancel/i.test(text)) return 'Se canceló o se acabó el tiempo. Inténtalo otra vez.';
  if (/InvalidState|already registered|excluded/i.test(text)) return 'Este equipo ya tiene una passkey para esta cuenta.';
  if (/aal2|AAL2|insufficient_aal/i.test(text)) return 'Primero entra con el código de tu app de autenticación; después podrás añadir la passkey.';
  if (/not.*(enabled|supported)|disabled|webauthn/i.test(text) && /enable|disabled|not supported|feature/i.test(text))
    return 'Las passkeys todavía no están activas para Hallway. Habla con quien administra la app.';
  if (/network|fetch/i.test(text)) return 'No se pudo conectar. Revisa tu internet e inténtalo de nuevo.';
  return 'No se pudo usar la passkey. Inténtalo otra vez o usa el código de tu app.';
}

/** A name for the passkey that says which device it is: «iPhone · 15 nov 2026». */
function deviceName() {
  const ua = navigator.userAgent;
  const device = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'Chromebook' : 'Este equipo';
  const day = new Date().toLocaleDateString('es-PR', { day: 'numeric', month: 'short', year: 'numeric' });
  return `${device} · ${day} · ${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Makes a passkey on this device for the open account (Face ID, huella o PIN). It also counts as today's second step.
 * Supabase closes the account's sessions on other devices, as with the authenticator app.
 */
export async function addPasskey(me) {
  if (!passkeysHere()) throw new Error(`Las passkeys se crean desde ${PASSKEY_HOST}, en un navegador que las acepte.`);
  const { data: factors } = await sb.auth.mfa.listFactors();
  // An earlier attempt that never finished.
  for (const f of factors?.all || []) {
    if (f.factor_type === 'webauthn' && f.status !== 'verified') await sb.auth.mfa.unenroll({ factorId: f.id }).catch(() => {});
  }
  const friendlyName = deviceName();
  const { error } = await sb.auth.mfa.webauthn.register({ friendlyName, webauthn: webauthn() });
  if (error) throw new Error(passkeyError(error));
  const id = (await secondSteps()).passkeys.find((f) => f.friendly_name === friendlyName)?.id;
  if (id) local('passkey', me.user.id, id);
  rememberStep(me.user.id, 'passkey');
  return id;
}

/** Today's second step with a passkey of the account. */
export async function checkPasskey(factorId) {
  const { error } = await sb.auth.mfa.webauthn.authenticate({ factorId, webauthn: webauthn() });
  if (error) throw new Error(passkeyError(error));
}

/** Removes a passkey from the account (its device can't use it anymore). */
export async function removePasskey(me, factorId) {
  const { error } = await sb.auth.mfa.unenroll({ factorId });
  if (error) throw new Error(/aal2|insufficient/i.test(`${error.code} ${error.message}`)
    ? 'Primero pasa la verificación de hoy; después podrás quitarla.'
    : 'No se pudo quitar la passkey. Revisa tu internet e inténtalo de nuevo.');
  if (local('passkey', me.user.id) === factorId) local('passkey', me.user.id, null);
}

/**
 * A new authenticator to scan: { factorId, qr (SVG), secret (to type it by hand) }. In the authenticator app it
 * shows as «Hallway · <role>» with the person and the school, not Supabase's internal address, so someone with two
 * accounts (Administración and IT) knows which code is which.
 */
export async function startAuthenticator(me) {
  const { data: factors } = await sb.auth.mfa.listFactors();
  // A previous attempt that was never confirmed.
  for (const f of factors?.all || []) {
    if (f.factor_type === 'totp' && f.status !== 'verified') await sb.auth.mfa.unenroll({ factorId: f.id }).catch(() => {});
  }
  const issuer = `Hallway · ${roleLabel(me.user.role) || 'Cuenta'}`;
  const { data, error } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: issuer, issuer });
  if (error) throw new Error('No se pudo preparar la verificación. Habla con la dirección para que la active en Supabase.');
  // Same secret, our own label: «issuer:account» plus issuer= (spaces as %20, which every authenticator app reads).
  const params = new URL(data.totp.uri).searchParams;
  params.set('issuer', issuer);
  const query = [...params].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const account = `${me.user.full_name} · ${me.school.name}`;
  const uri = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?${query}`;
  const { default: qrcode } = await import('../vendor/qrcode.js');
  const qr = qrcode(0, 'M');
  qr.addData(uri);
  qr.make();
  return { factorId: data.id, qr: qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true, alt: 'Código QR para la app de autenticación' }), secret: data.totp.secret, issuer, account };
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
