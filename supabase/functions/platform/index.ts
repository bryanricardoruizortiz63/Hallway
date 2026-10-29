// Platform panel: create and manage schools. The most protected door of Hallway:
//   * Signing in takes the platform password (bcrypt hash in app_settings.platform_password) and, every time, the code
//     of an authenticator app (TOTP), or one sent by email to the platform owner. The first time it shows the QR to set
//     up the app and one recovery code (used once; then a new one is shown).
//   * Then a session: 20 minutes without use or 8 hours at most. Only its hash is stored; the app keeps the token in
//     memory, so a reload means signing in again.
//   * Every sign-in, failed attempt and change goes to platform_audit; 10 failed attempts in 15 minutes lock the door
//     for 15 minutes. Calls only from the app's own address (Origin).
import {
  authEmail,
  HttpError,
  json,
  limitIp,
  readJson,
  reqText,
  serve,
  serviceClient,
  validatePassword,
} from '../_shared/http.ts';
import { newSecret, otpauthUri, verifyTotp } from './totp.ts';

const db = serviceClient();
const MODULES = ['turns', 'support', 'alerts', 'maintenance', 'rooms', 'visits', 'live'];
const ICON_FILES = ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'icon-maskable-512.png'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The schools picked in the panel; all must exist. */
async function pickSchools(value: unknown): Promise<string[]> {
  const ids = Array.isArray(value) ? [...new Set(value.map(String).filter((id) => UUID_RE.test(id)))] : [];
  if (!ids.length) throw new HttpError(400, 'Elige al menos una escuela.');
  const { data } = await db.from('schools').select('id').in('id', ids);
  if ((data || []).length !== ids.length) throw new HttpError(404, 'No se encontró alguna de las escuelas.');
  return ids;
}

function decodePng(value: unknown, name: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(String(value || '')), (c) => c.charCodeAt(0));
  } catch {
    throw new HttpError(400, `El archivo ${name} no es válido.`);
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 100 || !png.every((b, i) => bytes[i] === b)) throw new HttpError(400, `${name} no es una imagen PNG.`);
  if (bytes.length > 1_048_576) throw new HttpError(400, `${name} pesa más de 1 MB.`);
  return bytes;
}

function normalizeCode(code: unknown): string {
  return String(code || '').trim().toUpperCase();
}

function validateCode(code: string) {
  if (!/^[A-Z0-9][A-Z0-9-]{2,19}$/.test(code)) {
    throw new HttpError(400, 'El código de escuela debe tener de 3 a 20 letras, números o guiones.');
  }
}

/** A code is taken if a school uses it now or used it before (old codes keep working for that school). */
async function codeExists(code: string): Promise<boolean> {
  const [{ data: school }, { data: old }] = await Promise.all([
    db.from('schools').select('id').eq('code', code).maybeSingle(),
    db.from('school_code_history').select('code').eq('code', code).maybeSingle(),
  ]);
  return !!school || !!old;
}

/** Suggests a readable code from the school name, e.g. "Leap Academy" -> "LA-4821". */
async function suggestCode(name: string): Promise<string> {
  const initials =
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 2 || /^[A-Z]/.test(w))
      .map((w) => w[0].toUpperCase())
      .join('')
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 6) || 'ESC';
  for (let i = 0; i < 50; i++) {
    const n = 1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9000);
    const code = `${initials.padEnd(2, 'X')}-${n}`;
    if (!(await codeExists(code))) return code;
  }
  throw new HttpError(500, 'No se pudo generar un código único.');
}

// ---- Who is calling ---------------------------------------------------------------------------

const ORIGINS = ['https://app.hallwayedu.com'];
const IDLE_MS = 20 * 60_000;
const MAX_MS = 8 * 3_600_000;
const PENDING_MS = 5 * 60_000;
const LOCK_FAILS = 10;
const LOCK_MS = 15 * 60_000;
const ISSUER = 'Hallway · Plataforma';
const EMAIL_CODE_MS = 10 * 60_000;
const EMAIL_FROM = 'Hallway <notificaciones@hallwayedu.com>';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Caller = { ip: string; ua: string };

function callerOf(req: Request): Caller {
  return {
    ip: (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'desconocida',
    ua: (req.headers.get('user-agent') || '').slice(0, 200),
  };
}

async function audit(c: Caller, action: string, ok: boolean, detail: string | null = null) {
  await db.from('platform_audit').insert({ action, ok, ip: c.ip, user_agent: c.ua, detail });
}

async function sha256(text: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** «K7QM-2XWP-HD4R-9BNA»: one code, easy to copy (about 79 bits). */
function recoveryCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint32Array(16));
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  return chars.match(/.{4}/g)!.join('-');
}

/** «b•••••@gmail.com»: enough to know where it went. */
function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  return `${user[0]}${'•'.repeat(Math.max(2, Math.min(user.length - 1, 6)))}@${domain}`;
}

/** Sends through Resend (secret RESEND_API_KEY). */
async function sendEmail(to: string, subject: string, text: string) {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) throw new HttpError(400, 'El correo de la plataforma todavía no está configurado (falta RESEND_API_KEY). Usa el código de la app.');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    console.error('resend', res.status, await res.text().catch(() => ''));
    throw new HttpError(502, 'No se pudo enviar el correo. Usa el código de la app.');
  }
}

type Security = {
  totp_secret: string | null;
  totp_enabled: boolean;
  totp_last_counter: number | null;
  pending_secret: string | null;
  recovery_hashes: string[];
  email: string | null;
  email_code_hash: string | null;
  email_code_expires_at: string | null;
  email_code_sent_at: string | null;
};

async function security(): Promise<Security> {
  const { data, error } = await db.from('platform_security').select('*').eq('id', true).single();
  if (error) throw error;
  return data as Security;
}

async function saveSecurity(changes: Partial<Security>) {
  const { error } = await db.from('platform_security').update({ ...changes, updated_at: new Date().toISOString() }).eq('id', true);
  if (error) throw error;
}

/** 10 failed attempts (from anywhere) in 15 minutes close the door for 15 minutes. */
async function checkLock() {
  const since = new Date(Date.now() - LOCK_MS).toISOString();
  const { count } = await db
    .from('platform_audit')
    .select('id', { count: 'exact', head: true })
    .eq('ok', false)
    .in('action', ['password', 'code'])
    .gte('at', since);
  if ((count ?? 0) >= LOCK_FAILS) {
    throw new HttpError(429, 'Demasiados intentos fallidos. El panel queda cerrado 15 minutos.');
  }
}

async function failSlowly(c: Caller, action: string, message: string): Promise<never> {
  await audit(c, action, false);
  await new Promise((r) => setTimeout(r, 900));
  throw new HttpError(401, message);
}

async function checkPassword(c: Caller, password: unknown) {
  const { data: ok } = await db.rpc('platform_check_password', { p_password: String(password || '') });
  if (!ok) await failSlowly(c, 'password', 'Contraseña de plataforma incorrecta.');
}

/**
 * The code of the authenticator app, one sent by email (10 minutes, once) or the recovery code (once; a new one is
 * made). Returns what was used.
 */
async function checkCode(c: Caller, sec: Security, code: unknown, allowRecovery = true): Promise<'code' | 'email' | 'recovery'> {
  const text = String(code || '').trim().toUpperCase().replace(/[\s-]+/g, '');
  if (/^\d{6}$/.test(text)) {
    if (sec.totp_secret) {
      const counter = await verifyTotp(sec.totp_secret, text, sec.totp_last_counter);
      if (counter !== null) {
        await saveSecurity({ totp_last_counter: counter });
        return 'code';
      }
    }
    if (sec.email_code_hash && sec.email_code_expires_at && Date.parse(sec.email_code_expires_at) > Date.now()
      && await sha256(`email:${text}`) === sec.email_code_hash) {
      await saveSecurity({ email_code_hash: null, email_code_expires_at: null });
      return 'email';
    }
  } else if (allowRecovery && /^[A-Z0-9]{16}$/.test(text)) {
    if (sec.recovery_hashes.includes(await sha256(text))) return 'recovery';
  }
  return await failSlowly(c, 'code', 'Ese código no es correcto o ya se usó. Escribe el que sale ahora en la app.');
}

/** The one recovery code (the old one stops working). */
async function newRecoveryCode(): Promise<string> {
  const code = recoveryCode();
  await saveSecurity({ recovery_hashes: [await sha256(code.replace(/-/g, ''))] });
  return code;
}

async function openSession(c: Caller, kind: 'pending' | 'full'): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  const { error } = await db.from('platform_sessions').insert({
    token_hash: await sha256(token),
    kind,
    expires_at: new Date(now + (kind === 'pending' ? PENDING_MS : MAX_MS)).toISOString(),
    ip: c.ip,
    user_agent: c.ua,
  });
  if (error) throw error;
  // Old ones go away.
  await db.from('platform_sessions').delete().lt('expires_at', new Date(now).toISOString());
  await db.from('platform_sessions').delete().lt('last_seen_at', new Date(now - IDLE_MS).toISOString());
  return token;
}

/** The session behind a token, still open (and, for a full one, used in the last 20 minutes). */
async function session(token: unknown, kind: 'pending' | 'full'): Promise<string> {
  const hash = await sha256(String(token || ''));
  const { data } = await db.from('platform_sessions').select('*').eq('token_hash', hash).eq('kind', kind).maybeSingle();
  const now = Date.now();
  if (!data || Date.parse(data.expires_at) < now || (kind === 'full' && Date.parse(data.last_seen_at) < now - IDLE_MS)) {
    if (data) await db.from('platform_sessions').delete().eq('token_hash', hash);
    throw new HttpError(401, kind === 'pending'
      ? 'Pasó mucho tiempo. Escribe la contraseña otra vez.'
      : 'Tu sesión del panel terminó. Entra otra vez con tu contraseña y el código.');
  }
  if (kind === 'full') await db.from('platform_sessions').update({ last_seen_at: new Date(now).toISOString() }).eq('token_hash', hash);
  return hash;
}

/** Signing in, step by step. */
const signIn: Record<string, (c: Caller, b: Record<string, unknown>) => Promise<Response>> = {
  /** 1. The password. Then the code, or the first time, the QR. */
  async start(c, b) {
    await checkPassword(c, b.password);
    await audit(c, 'password', true);
    const sec = await security();
    const pending = await openSession(c, 'pending');
    if (sec.totp_enabled && sec.totp_secret) {
      return json({ next: 'code', pending, email: sec.email ? maskEmail(sec.email) : null });
    }
    const secret = newSecret();
    await saveSecurity({ pending_secret: secret });
    return json({ next: 'setup', pending, secret, uri: otpauthUri(secret, ISSUER, 'Panel de plataforma') });
  },

  /** 2 (instead of the app). A 6-digit code by email to the platform owner, at most one a minute. */
  async email_code(c, b) {
    await session(b.pending, 'pending');
    const sec = await security();
    if (!sec.totp_enabled) throw new HttpError(400, 'Primero configura la app de autenticación.');
    if (!sec.email) throw new HttpError(400, 'Todavía no hay un correo para la plataforma. Usa el código de la app.');
    if (sec.email_code_sent_at && Date.parse(sec.email_code_sent_at) > Date.now() - 60_000) {
      throw new HttpError(429, 'Ya se envió un código hace menos de un minuto. Revisa tu correo (y la carpeta de spam).');
    }
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
    await saveSecurity({
      email_code_hash: await sha256(`email:${code}`),
      email_code_expires_at: new Date(Date.now() + EMAIL_CODE_MS).toISOString(),
      email_code_sent_at: new Date().toISOString(),
    });
    await sendEmail(sec.email, `Tu código para el Panel de plataforma: ${code}`,
      `Tu código para entrar al Panel de plataforma de Hallway es:\n\n    ${code}\n\nVale 10 minutos y una sola vez.\n\n` +
      `Lo pidieron desde la IP ${c.ip}. Si no fuiste tú, alguien tiene tu contraseña de plataforma: cámbiala en el panel.`);
    await audit(c, 'email_code', true, maskEmail(sec.email));
    return json({ sent: maskEmail(sec.email) });
  },

  /** 2. The code of the app, the one sent by email, or the recovery code. */
  async verify(c, b) {
    const pendingHash = await session(b.pending, 'pending');
    const sec = await security();
    if (!sec.totp_enabled) throw new HttpError(400, 'Primero configura la app de autenticación.');
    const used = await checkCode(c, sec, b.code);
    await db.from('platform_sessions').delete().eq('token_hash', pendingHash);
    await audit(c, 'code', true, used === 'recovery' ? 'con el código de recuperación' : used === 'email' ? 'con un código por correo' : null);
    // The recovery code works once: here is the next one.
    const recovery = used === 'recovery' ? await newRecoveryCode() : null;
    return json({ session: await openSession(c, 'full'), recovery_code: recovery });
  },

  /** 2 (first time). The first code from the app just set up: from now on, it's required. */
  async setup(c, b) {
    const pendingHash = await session(b.pending, 'pending');
    const sec = await security();
    if (sec.totp_enabled) throw new HttpError(400, 'La app de autenticación ya está configurada.');
    if (!sec.pending_secret) throw new HttpError(400, 'Escribe la contraseña otra vez para ver el QR.');
    const counter = await verifyTotp(sec.pending_secret, String(b.code || '').trim(), null);
    if (counter === null) await failSlowly(c, 'code', 'Ese código no es correcto. Escribe el que sale ahora en la app.');
    await saveSecurity({ totp_secret: sec.pending_secret, totp_enabled: true, totp_last_counter: counter, pending_secret: null });
    const recovery = await newRecoveryCode();
    await db.from('platform_sessions').delete().eq('token_hash', pendingHash);
    await audit(c, 'setup', true, 'app de autenticación configurada');
    return json({ session: await openSession(c, 'full'), recovery_code: recovery });
  },
};

async function adminOf(schoolId: unknown): Promise<{ id: string }> {
  const { data } = await db.from('profiles').select('id').eq('school_id', String(schoolId)).eq('role', 'admin').maybeSingle();
  if (!data) throw new HttpError(404, 'Escuela no encontrada.');
  return data;
}

const actions: Record<string, (b: Record<string, unknown>, c: Caller, sessionHash: string) => Promise<Response>> = {
  async list_schools() {
    const { data, error } = await db.rpc('platform_schools');
    if (error) throw error;
    return json({ schools: data });
  },

  async create_school(b) {
    const name = reqText(b.name, 150, 'El nombre de la escuela');
    const code = b.code ? normalizeCode(b.code) : await suggestCode(name);
    validateCode(code);
    if (await codeExists(code)) throw new HttpError(409, 'Ya existe una escuela con ese código.');
    const password = validatePassword(b.admin_password);

    const { data: school, error } = await db.from('schools').insert({ code, name }).select().single();
    if (error) throw error;
    const rollback = () => db.from('schools').delete().eq('id', school.id);
    await db.from('school_settings').insert({ school_id: school.id });

    const { data: created, error: authError } = await db.auth.admin.createUser({
      email: await authEmail(code, 'admin'),
      password,
      email_confirm: true,
      app_metadata: { school_id: school.id },
    });
    if (authError || !created.user) {
      await rollback();
      console.error(authError);
      throw new HttpError(500, 'No se pudo crear la cuenta admin.');
    }
    const { error: profileError } = await db.from('profiles').insert({
      id: created.user.id,
      school_id: school.id,
      role: 'admin',
      username: 'admin',
      full_name: 'Admin',
    });
    if (profileError) {
      await db.auth.admin.deleteUser(created.user.id);
      await rollback();
      throw profileError;
    }
    return json({ school: { id: school.id, code, name } }, 201);
  },

  async set_school_active(b) {
    const { error } = await db.from('schools').update({ active: b.active === true }).eq('id', String(b.school_id));
    if (error) throw error;
    return json({ ok: true });
  },

  /** What the school doesn't use: the app hides those tabs, links and services. */
  async set_school_modules(b) {
    const disabled = Array.isArray(b.disabled_modules) ? [...new Set(b.disabled_modules.map(String))] : [];
    if (disabled.some((m) => !MODULES.includes(m))) throw new HttpError(400, 'Módulo no válido.');
    const { error } = await db.from('schools').update({ disabled_modules: disabled }).eq('id', String(b.school_id));
    if (error) throw error;
    return json({ ok: true });
  },

  /** The icon the app, emails and notifications show to the people of these schools. */
  async set_school_icon(b) {
    const ids = await pickSchools(b.school_ids);
    const files = (b.files || {}) as Record<string, unknown>;
    const images = ICON_FILES.map((name) => [name, decodePng(files[name], name)] as const);
    for (const id of ids) {
      for (const [name, bytes] of images) {
        // Links carry ?v=icon_version, so browsers may keep each file for a year.
        const { error } = await db.storage
          .from('branding')
          .upload(`${id}/${name}`, bytes, { contentType: 'image/png', upsert: true, cacheControl: '31536000' });
        if (error) {
          console.error(error);
          throw new HttpError(500, 'No se pudo guardar el ícono. Inténtalo de nuevo.');
        }
      }
    }
    const version = Date.now();
    const { error } = await db.from('schools').update({ icon_version: version }).in('id', ids);
    if (error) throw error;
    return json({ updated: ids.length, icon_version: version });
  },

  /** Back to the default icon. */
  async reset_school_icon(b) {
    const ids = await pickSchools(b.school_ids);
    await db.storage.from('branding').remove(ids.flatMap((id) => ICON_FILES.map((name) => `${id}/${name}`)));
    const { error } = await db.from('schools').update({ icon_version: null }).in('id', ids);
    if (error) throw error;
    return json({ updated: ids.length });
  },

  async reset_admin_password(b) {
    const admin = await adminOf(b.school_id);
    const password = validatePassword(b.new_password);
    const { error } = await db.auth.admin.updateUserById(admin.id, { password });
    if (error) throw error;
    return json({ ok: true });
  },

  // ---- The panel's own security ----

  /** Recent activity, open sessions, the email and whether there is a recovery code. */
  async security_overview(_b, _c, sessionHash) {
    const [{ data: events }, { data: sessions }, sec] = await Promise.all([
      db.from('platform_audit').select('at, action, ok, ip, user_agent, detail').order('at', { ascending: false }).limit(40),
      db.from('platform_sessions').select('token_hash, created_at, last_seen_at, ip, user_agent').eq('kind', 'full')
        .gte('last_seen_at', new Date(Date.now() - IDLE_MS).toISOString()).order('created_at', { ascending: false }),
      security(),
    ]);
    return json({
      events,
      sessions: (sessions || []).map(({ token_hash, ...s }) => ({ ...s, current: token_hash === sessionHash })),
      has_recovery: sec.recovery_hashes.length > 0,
      email: sec.email,
      email_ready: !!Deno.env.get('RESEND_API_KEY'),
    });
  },

  async logout(_b, c, sessionHash) {
    await db.from('platform_sessions').delete().eq('token_hash', sessionHash);
    await audit(c, 'logout', true);
    return json({ ok: true });
  },

  /** Closes every other open session (another computer, a forgotten tab). */
  async logout_others(_b, c, sessionHash) {
    await db.from('platform_sessions').delete().neq('token_hash', sessionHash);
    await audit(c, 'logout_others', true);
    return json({ ok: true });
  },

  /** New platform password: the current one and a code first; every other session closes. */
  async change_password(b, c, sessionHash) {
    await checkPassword(c, b.current_password);
    await checkCode(c, await security(), b.code, false);
    const next = String(b.new_password || '');
    if (next.length < 12) throw new HttpError(400, 'La nueva contraseña debe tener al menos 12 caracteres.');
    if (next.length > 72) throw new HttpError(400, 'La nueva contraseña es demasiado larga (máx. 72 caracteres).');
    const { error } = await db.rpc('platform_set_password', { p_password: next });
    if (error) throw new HttpError(400, error.message);
    await db.from('platform_sessions').delete().neq('token_hash', sessionHash);
    await audit(c, 'change_password', true);
    return json({ ok: true });
  },

  /** A new recovery code (the old one stops working). */
  async new_recovery_code(b, c) {
    await checkCode(c, await security(), b.code, false);
    const code = await newRecoveryCode();
    await audit(c, 'recovery_codes', true);
    return json({ recovery_code: code });
  },

  /** Where the sign-in codes by email go (empty: none). A code of the app first; a test email is sent. */
  async set_email(b, c) {
    await checkCode(c, await security(), b.code, false);
    const email = String(b.email || '').trim().toLowerCase();
    if (email && (!EMAIL_RE.test(email) || email.length > 200)) throw new HttpError(400, 'Ese correo no es válido.');
    if (email) {
      await sendEmail(email, 'Hallway · Correo del Panel de plataforma',
        'Este correo recibirá los códigos para entrar al Panel de plataforma de Hallway cuando los pidas en lugar del código de la app.');
    }
    await saveSecurity({ email: email || null, email_code_hash: null, email_code_expires_at: null });
    await audit(c, 'set_email', true, email ? maskEmail(email) : 'sin correo');
    return json({ ok: true });
  },

  /** A new phone: the current code, then the next sign-in shows a new QR. Every session closes. */
  async reset_authenticator(b, c) {
    await checkPassword(c, b.password);
    await checkCode(c, await security(), b.code, false);
    await saveSecurity({ totp_enabled: false, totp_secret: null, totp_last_counter: null, recovery_hashes: [], email_code_hash: null });
    await db.from('platform_sessions').delete().neq('token_hash', '');
    await audit(c, 'reset_authenticator', true);
    return json({ ok: true });
  },
};

serve(async (req) => {
  // Only from the app itself: a page on another site can't call the panel.
  const origin = req.headers.get('origin');
  if (!origin || !ORIGINS.includes(origin)) throw new HttpError(403, 'Acceso no permitido.');
  const c = callerOf(req);
  const body = await readJson(req);
  const step = signIn[String(body.step || '')];
  if (step) {
    // Signing in: few tries a minute from one place, and the door closes after too many failures.
    await limitIp(db, req, 'platform', 10);
    await checkLock();
    return step(c, body);
  }
  await limitIp(db, req, 'platform-session', 120);
  const sessionHash = await session(body.session, 'full');
  const action = actions[String(body.action)];
  if (!action) throw new HttpError(400, 'Acción no válida.');
  return action(body, c, sessionHash);
});
