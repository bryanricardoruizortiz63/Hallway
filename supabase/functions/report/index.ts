// What the app tells Hallway's creator, also before signing in:
//   * error         an error the app had on a screen (the signed-in ones use log_app_error directly).
//   * login_failed  a failed sign-in: the server works out whether the school code, the username or the password was
//                   wrong. After 5 failures for the same account in 15 minutes, or 10 from the same IP, the creator gets
//                   an email (the platform's address) with the person, the school, the IP and the device; at most one
//                   per account (or IP) an hour, and 20 a day.
// Both kept 30 days (app_errors, login_failures). Few calls a minute from one IP.
import { HttpError, json, limitIp, readJson, serve, serviceClient } from '../_shared/http.ts';
import { sendPlatformEmail } from '../_shared/resend.ts';

const db = serviceClient();
const WINDOW_MS = 15 * 60_000;
const ACCOUNT_LIMIT = 5;
const IP_LIMIT = 10;
const TZ = 'America/Puerto_Rico';

type Caller = { ip: string; device: string };

const callerOf = (req: Request): Caller => ({
  ip: (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'desconocida',
  device: (req.headers.get('user-agent') || '').slice(0, 300),
});

const text = (v: unknown, max: number) => (v === undefined || v === null ? null : String(v).trim().slice(0, max) || null);

const when = (iso: string) =>
  new Date(iso).toLocaleString('es', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' });

const REASONS: Record<string, string> = {
  school: 'el código de escuela no existe',
  username: 'el usuario no existe en esa escuela',
  password: 'contraseña incorrecta',
  inactive: 'la cuenta está desactivada',
  other: 'otro motivo',
};

/** A short, readable name for the device: «iPhone · Safari», «Windows · Chrome». */
function deviceName(ua: string): string {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : 'Otro';
  const browser = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari' : 'otro navegador';
  return `${os} · ${browser}`;
}

/** The school a code belongs to (its current code or an old one). */
async function schoolOf(code: string) {
  if (!code) return null;
  const { data: now } = await db.from('schools').select('id, name, code').eq('code', code).maybeSingle();
  if (now) return now;
  const { data: old } = await db.from('school_code_history').select('school_id').eq('code', code).maybeSingle();
  if (!old) return null;
  const { data } = await db.from('schools').select('id, name, code').eq('id', old.school_id).maybeSingle();
  return data;
}

async function ownerEmail(): Promise<string | null> {
  const { data } = await db.from('platform_security').select('email').eq('id', true).maybeSingle();
  return (data?.email as string | null) || null;
}

/** The creator's email about repeated failures; marks the rows so the same ones don't alert again. */
async function alert(kind: 'account' | 'ip', rows: Record<string, unknown>[], c: Caller) {
  const to = await ownerEmail();
  if (!to) return;
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { count } = await db.from('login_failures').select('id', { count: 'exact', head: true }).eq('alerted', true).gte('at', since);
  // 20 emails a day at most: past that the panel still shows everything.
  if ((count ?? 0) >= 20 * ACCOUNT_LIMIT) return;
  const last = rows[0];
  const people = [...new Set(rows.map((r) => `${r.username || '—'}${r.user_name ? ` (${r.user_name})` : ''}`))];
  const schools = [...new Set(rows.map((r) => (r.school_name ? `${r.school_name} (${r.school_code})` : `${r.school_code || '—'} (no existe)`)))];
  const subject = kind === 'account'
    ? `⚠️ Hallway: ${rows.length} intentos fallidos para entrar como «${last.username}»`
    : `⚠️ Hallway: ${rows.length} intentos fallidos desde la IP ${c.ip}`;
  const lines = [
    kind === 'account'
      ? `Alguien intentó entrar ${rows.length} veces en 15 minutos con la misma cuenta y no lo logró.`
      : `Desde una misma IP se intentó entrar ${rows.length} veces en 15 minutos (${people.length} cuenta(s) distinta(s)).`,
    '',
    `Escuela: ${schools.join(', ')}`,
    `Usuario: ${people.join(', ')}`,
    `IP: ${[...new Set(rows.map((r) => r.ip))].join(', ')}`,
    `Dispositivo: ${[...new Set(rows.map((r) => deviceName(String(r.device || ''))))].join(', ')}`,
    '',
    'Intentos:',
    ...rows.slice(0, 15).map((r) => `  • ${when(String(r.at))} — ${REASONS[String(r.reason)] || r.reason} (usuario «${r.username || '—'}», código «${r.school_code || '—'}»)`),
    '',
    'Si es la persona que olvidó su contraseña, la dirección de su escuela puede darle una temporal. Si no reconoces esto,',
    'revisa en el Panel de plataforma › Intentos fallidos. Este aviso no se repite para la misma cuenta o IP en una hora.',
    '',
    `Dispositivo completo: ${c.device || '—'}`,
  ];
  try {
    await sendPlatformEmail(to, subject, lines.join('\n'));
    await db.from('login_failures').update({ alerted: true }).in('id', rows.map((r) => r.id as number));
  } catch (err) {
    console.error('alert email', err);
  }
}

const actions: Record<string, (b: Record<string, unknown>, c: Caller, req: Request) => Promise<Response>> = {
  /** An error the app had before signing in (the login screen, the verification page…). */
  async error(b, c, req) {
    await limitIp(db, req, 'report-error', 30);
    const message = text(b.message, 1000);
    if (!message) throw new HttpError(400, 'Falta el mensaje.');
    await db.from('app_errors').insert({
      source: 'app', kind: text(b.kind, 40), route: text(b.route, 300), message, detail: text(b.detail, 8000),
      status: Number.isInteger(b.status) ? b.status : null, ip: c.ip, device: c.device, app_version: text(b.app_version, 40),
      user_name: text(b.username, 120),
    });
    return json({ ok: true });
  },

  /** A failed sign-in: why it failed, and the creator's email after too many. */
  async login_failed(b, c, req) {
    await limitIp(db, req, 'report-login', 30);
    const code = String(b.code || '').trim().toUpperCase().slice(0, 40);
    const username = String(b.username || '').trim().toLowerCase().slice(0, 120);
    const school = await schoolOf(code);
    let person: { id: string; full_name: string; active: boolean } | null = null;
    if (school && username) {
      const { data } = await db.from('profiles').select('id, full_name, active').eq('school_id', school.id).eq('username', username).maybeSingle();
      person = data;
    }
    const reason = !school ? 'school' : !person ? 'username' : !person.active ? 'inactive' : 'password';
    await db.from('login_failures').insert({
      school_code: code || null, school_id: school?.id || null, school_name: school?.name || null, username: username || null,
      user_id: person?.id || null, user_name: person?.full_name || null, reason, ip: c.ip, device: c.device,
    });

    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const cols = 'id, at, school_code, school_name, username, user_name, reason, ip, device, alerted';
    // The same account.
    const { data: same } = await db.from('login_failures').select(cols)
      .eq('school_code', code).eq('username', username).gte('at', since).order('at', { ascending: false });
    const { count: accountAlerted } = await db.from('login_failures').select('id', { count: 'exact', head: true })
      .eq('school_code', code).eq('username', username).eq('alerted', true).gte('at', hourAgo);
    if ((same || []).length >= ACCOUNT_LIMIT && !accountAlerted) {
      await alert('account', same!, c);
    } else {
      // The same place, many accounts.
      const { data: fromIp } = await db.from('login_failures').select(cols).eq('ip', c.ip).gte('at', since).order('at', { ascending: false });
      const { count: ipAlerted } = await db.from('login_failures').select('id', { count: 'exact', head: true })
        .eq('ip', c.ip).eq('alerted', true).gte('at', hourAgo);
      if ((fromIp || []).length >= IP_LIMIT && !ipAlerted) await alert('ip', fromIp!, c);
    }
    return json({ ok: true });
  },
};

serve(async (req) => {
  const body = await readJson(req);
  const action = actions[String(body.action)];
  if (!action) throw new HttpError(400, 'Acción no válida.');
  return action(body, callerOf(req), req);
});
