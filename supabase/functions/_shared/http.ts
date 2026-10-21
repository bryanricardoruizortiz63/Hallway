import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

/** Wraps a handler with CORS preflight and Spanish JSON errors. */
export function serve(fn: (req: Request) => Promise<Response>) {
  Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
    try {
      return await fn(req);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'Ocurrió un error inesperado. Inténtalo de nuevo.' }, 500);
    }
  });
}

/**
 * At most `max` calls a minute from the caller's IP (the first address of x-forwarded-for). If the counter can't
 * be read the call goes through: the limit is against bots, not a reason to break the app.
 */
export async function limitIp(db: SupabaseClient, req: Request, what: string, max = 60): Promise<void> {
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  const { data, error } = await db.rpc('edge_rate_limit', { p_key: `${what}:${ip}`, p_max: max });
  if (!error && data === false) throw new HttpError(429, 'Demasiados intentos. Espera un minuto e inténtalo de nuevo.');
}

function secretKey(): string {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
  return keys.default || Object.values(keys)[0];
}

export function serviceClient(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, secretKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function anonClient(): SupabaseClient {
  const legacy = Deno.env.get('SUPABASE_ANON_KEY');
  const keys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}');
  return createClient(Deno.env.get('SUPABASE_URL')!, legacy || keys.default || Object.values(keys)[0], {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Staff sign in with "school code + username". Supabase Auth needs an email, so each account gets a
 * stable internal address derived from both. The app computes the same value in the browser.
 */
export async function authEmail(code: string, username: string): Promise<string> {
  const data = new TextEncoder().encode(`${code.trim().toUpperCase()}|${username.trim().toLowerCase()}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  const hex = Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
  return `u${hex}@users.leap-hub.local`;
}

export function generatePassword(length = 10): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.getRandomValues(new Uint32Array(length)), (b) => alphabet[b % alphabet.length]).join('');
}

export function optText(value: unknown, max: number, label: string): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > max) throw new HttpError(400, `${label} es demasiado largo (máx. ${max} caracteres).`);
  return s;
}

export function reqText(value: unknown, max: number, label: string): string {
  const s = optText(value, max, label);
  if (!s) throw new HttpError(400, `${label} es requerido.`);
  return s;
}

export function validatePassword(pw: unknown): string {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres.');
  if (pw.length > 72) throw new HttpError(400, 'La contraseña es demasiado larga (máx. 72 caracteres).');
  return pw;
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (body && typeof body === 'object') return body as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new HttpError(400, 'Solicitud no válida.');
}
