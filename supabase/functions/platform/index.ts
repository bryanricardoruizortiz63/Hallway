// Platform panel: create and manage schools. Protected by the platform password
// (bcrypt hash stored in app_settings.platform_password).
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

async function adminOf(schoolId: unknown): Promise<{ id: string }> {
  const { data } = await db.from('profiles').select('id').eq('school_id', String(schoolId)).eq('role', 'admin').maybeSingle();
  if (!data) throw new HttpError(404, 'Escuela no encontrada.');
  return data;
}

const actions: Record<string, (b: Record<string, unknown>) => Promise<Response>> = {
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
      throw new HttpError(500, 'No se pudo crear la cuenta de administración.');
    }
    const { error: profileError } = await db.from('profiles').insert({
      id: created.user.id,
      school_id: school.id,
      role: 'admin',
      username: 'admin',
      full_name: 'Administración',
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
    // b.password is the platform password; the new admin password comes in new_password.
    const password = validatePassword(b.new_password);
    const { error } = await db.auth.admin.updateUserById(admin.id, { password });
    if (error) throw error;
    return json({ ok: true });
  },
};

serve(async (req) => {
  // The platform password is the only key: few tries a minute.
  await limitIp(db, req, 'platform', 10);
  const body = await readJson(req);
  const { data: ok } = await db.rpc('platform_check_password', { p_password: String(body.password || '') });
  if (!ok) {
    await new Promise((r) => setTimeout(r, 800));
    throw new HttpError(401, 'Contraseña de plataforma incorrecta.');
  }
  const action = actions[String(body.action)];
  if (!action) throw new HttpError(400, 'Acción no válida.');
  return action(body);
});
