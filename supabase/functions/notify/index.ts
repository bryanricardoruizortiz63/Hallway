// Processes one outbox row: a push notification to a user's devices, a Teams card for the school, or a
// cleanup job. Called by the database (pg_net) right after the row is inserted. Each row is processed only
// once, so calling it again is harmless.
import { json, serve, serviceClient } from '../_shared/http.ts';
import { deleteAbsences } from '../_shared/cleanup.ts';
import { buildCard, CATEGORIES, fmtRangeEs, postToTeams, scheduleText } from '../_shared/teams.ts';
import { sendWebPush, type VapidKeys } from '../_shared/webpush.ts';

const db = serviceClient();
const DAY = 86_400_000;

async function setting<T>(key: string): Promise<T | null> {
  const { data } = await db.from('app_settings').select('value').eq('key', key).maybeSingle();
  return (data?.value as T) ?? null;
}

async function handlePush(payload: { notification_id: number; repeat?: boolean }): Promise<string> {
  const { data: n } = await db
    .from('notifications')
    .select('id, user_id, title, body, link, tag, urgent, read_at')
    .eq('id', payload.notification_id)
    .maybeSingle();
  if (!n) return 'push: notification not found';
  // An urgent notice is pushed again every minute until it's opened or someone takes care of it.
  if (payload.repeat && n.read_at) return 'push: already read';
  const { data: subs } = await db.from('push_subscriptions').select('id, endpoint, p256dh, auth').eq('user_id', n.user_id);
  if (!subs?.length) return 'push: no subscriptions';
  const vapid = await setting<VapidKeys>('vapid');
  if (!vapid) return 'push: VAPID keys missing';

  // The school's own icon, when it has one (set from the platform panel).
  const { data: owner } = await db.from('profiles').select('school:schools(id, icon_version)').eq('id', n.user_id).maybeSingle();
  const school = owner?.school as unknown as { id: string; icon_version: number | null } | null;
  const icon = school?.icon_version
    ? `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/branding/${school.id}/icon-192.png?v=${school.icon_version}`
    : undefined;
  // uid: with two accounts on one phone, the app opens the notice as the account it belongs to.
  const message = JSON.stringify({
    title: n.title, body: n.body || '', url: n.link || '#/notifications', icon, tag: n.tag, urgent: n.urgent, uid: n.user_id,
  });
  // An urgent notice that arrives more than 15 minutes late is no use.
  const options = { ttl: n.urgent ? 900 : 86400 };
  const results = await Promise.all(
    subs.map(async (s) => {
      try {
        const res = await sendWebPush(s, message, vapid, options);
        if (res.status === 404 || res.status === 410) await db.from('push_subscriptions').delete().eq('id', s.id);
        return String(res.status);
      } catch (err) {
        return `err ${(err as Error).message}`;
      }
    }),
  );
  return `push: ${results.join(', ')}`;
}

type TeamsPayload = { event: string; absence_id?: number; user_id?: string; history_id?: number; reopened?: boolean };
type Change = { label: string; before?: string | null; after?: string | null };
// deno-lint-ignore no-explicit-any
type Settings = Record<string, any>;

const clip = (s: string | null | undefined, max = 300) => (s && s.length > max ? `${s.slice(0, max - 1)}…` : s || '');

async function appLink(route: string): Promise<string | null> {
  const app = await setting<{ url: string }>('app_url');
  return app?.url ? `${app.url.replace(/\/?$/, '/')}#${route}` : null;
}

async function passwordHelpCard(schoolName: string | undefined, payload: TeamsPayload) {
  const { data: p } = await db.from('profiles').select('id, full_name, username, position').eq('id', payload.user_id).maybeSingle();
  if (!p) return null;
  return buildCard({
    title: '🔑 Solicitud de contraseña',
    subtitle: schoolName,
    facts: [
      { title: 'Empleado', value: p.full_name },
      { title: 'Usuario', value: p.username },
      { title: 'Puesto', value: p.position },
    ],
    text: 'Olvidó su contraseña. En la app: Personal → su nombre → Restablecer contraseña, y compártele la contraseña temporal.',
    linkUrl: await appLink(`/employees/${p.id}`),
    linkTitle: 'Abrir su ficha',
  });
}

async function absenceCard(schoolName: string | undefined, settings: Settings, payload: TeamsPayload) {
  const { data: a } = await db.from('absences_v').select('*').eq('id', payload.absence_id).maybeSingle();
  if (!a) return null;
  const linkUrl = await appLink(`/absence/${a.id}`);
  const range = fmtRangeEs(a.start_date, a.end_date);
  const employee = { title: 'Empleado', value: a.employee_name };

  if (payload.event === 'cancelled') {
    const { data: h } = await db
      .from('absence_history')
      .select('actor_name, note')
      .eq('absence_id', a.id)
      .eq('action', 'cancelled')
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();
    return buildCard({
      title: '↩️ Ausencia cancelada',
      subtitle: schoolName,
      facts: [
        employee,
        { title: 'Fecha', value: range },
        { title: 'Cancelada por', value: h?.actor_name },
        { title: 'Motivo', value: clip(h?.note) },
      ],
      linkUrl,
    });
  }

  if (payload.event === 'edited') {
    const { data: h } = await db.from('absence_history').select('actor_name, note, changes').eq('id', payload.history_id).maybeSingle();
    const changes = (h?.changes || []) as Change[];
    return buildCard({
      title: '✏️ Ausencia modificada',
      subtitle: schoolName,
      facts: [
        employee,
        { title: 'Fecha', value: range },
        { title: 'Horario', value: scheduleText(a) },
        ...changes.map((c) => ({
          title: `Cambio: ${c.label}`,
          value:
            c.label === 'Causa' && !settings.teams_include_reason
              ? 'Modificada'
              : `${clip(c.before, 150) || '—'} → ${clip(c.after, 150) || '—'}`,
        })),
        { title: 'Modificada por', value: h?.actor_name },
        { title: 'Nota', value: clip(h?.note) },
      ],
      text: payload.reopened ? 'Cambió la fecha o la hora: hay que confirmarla de nuevo en la app.' : undefined,
      linkUrl,
    });
  }

  const onBehalf = a.created_by && a.created_by !== a.user_id;
  return buildCard({
    title: '🗓️ Nueva ausencia reportada',
    subtitle: schoolName,
    facts: [
      employee,
      { title: 'Puesto', value: a.employee_position },
      { title: 'Fecha', value: range },
      { title: 'Horario', value: scheduleText(a) },
      { title: 'Tipo', value: a.category ? CATEGORIES[a.category] : null },
      { title: 'Causa', value: settings.teams_include_reason ? a.reason : null },
      { title: 'Notas para cubrir', value: a.coverage_notes },
      { title: 'Documentos', value: a.attachment_count ? `${a.attachment_count} adjunto(s)` : null },
      { title: 'Registrada por', value: onBehalf ? a.created_by_name : null },
    ],
    linkUrl,
  });
}

async function handleTeams(schoolId: string, payload: TeamsPayload): Promise<string> {
  const { data: settings } = await db.from('school_settings').select('*').eq('school_id', schoolId).maybeSingle();
  if (!settings?.teams_enabled) return 'teams: skipped';
  // Password requests can go to their own channel; otherwise they share the absences channel.
  const passwordHelp = payload.event === 'password_help';
  const url = passwordHelp ? settings.teams_password_webhook_url || settings.teams_webhook_url : settings.teams_webhook_url;
  if (!url) return 'teams: skipped';
  const { data: school } = await db.from('schools').select('name').eq('id', schoolId).single();
  const card = passwordHelp ? await passwordHelpCard(school?.name, payload) : await absenceCard(school?.name, settings, payload);
  if (!card) return 'teams: record not found';

  let status = 'ok';
  try {
    await postToTeams(url, card);
  } catch (err) {
    status = `error: ${(err as Error).message}`.slice(0, 300);
  }
  if (url === settings.teams_webhook_url) {
    await db
      .from('school_settings')
      .update({ teams_last_status: status, teams_last_at: new Date().toISOString() })
      .eq('school_id', schoolId);
  }
  return `teams: ${status}`;
}

/**
 * Mantenimiento's photos go 30 days after the request is closed, and photos that never made it into a request
 * after a day; the requests themselves after a year.
 */
async function cleanMaintenance(): Promise<number> {
  const monthAgo = new Date(Date.now() - 30 * DAY).toISOString();
  const yearAgo = new Date(Date.now() - 365 * DAY).toISOString();
  const { data: closed, error } = await db
    .from('maintenance_requests')
    .select('id, photo_path')
    .not('photo_path', 'is', null)
    .or(`done_at.lt.${monthAgo},cancelled_at.lt.${monthAgo},created_at.lt.${yearAgo}`)
    .limit(500);
  if (error) throw new Error(error.message);
  const { data: orphans, error: orphanError } = await db.rpc('maintenance_orphan_photos');
  if (orphanError) throw new Error(orphanError.message);
  const paths = [...(closed || []).map((m) => m.photo_path as string), ...((orphans as string[] | null) || [])];
  // Files first: if Storage fails, the rows still point to them and the next run retries.
  for (let i = 0; i < paths.length; i += 100) {
    const { error: storageError } = await db.storage.from('maintenance').remove(paths.slice(i, i + 100));
    if (storageError) throw new Error(storageError.message);
  }
  if (closed?.length) {
    await db.from('maintenance_requests').update({ photo_path: null }).in('id', closed.map((m) => m.id as number));
  }
  await db.from('maintenance_requests').delete().lt('created_at', yearAgo);
  return paths.length;
}

/**
 * Daily (pg_cron): cancelled absences are kept 15 days, delivery logs 30 days, notifications 180 days, messages,
 * the services' turns (Enfermería, Trabajo Social), the visits and the conference room reservations a year; see
 * cleanMaintenance for Mantenimiento.
 */
async function maintenance(jobId: number): Promise<string> {
  const { data: old, error } = await db
    .from('absences')
    .select('id')
    .eq('status', 'cancelled')
    .lt('cancelled_at', new Date(Date.now() - 15 * DAY).toISOString())
    .limit(1000);
  if (error) throw new Error(error.message);
  const removed = await deleteAbsences(db, (old || []).map((a) => a.id as number));
  await db.from('outbox').delete().lt('created_at', new Date(Date.now() - 30 * DAY).toISOString()).neq('id', jobId);
  await db.from('notifications').delete().lt('created_at', new Date(Date.now() - 180 * DAY).toISOString());
  await db.from('messages').delete().lt('created_at', new Date(Date.now() - 365 * DAY).toISOString());
  await db.from('service_requests').delete().lt('created_at', new Date(Date.now() - 365 * DAY).toISOString());
  await db.from('room_bookings').delete().lt('day', new Date(Date.now() - 365 * DAY).toISOString().slice(0, 10));
  await db.from('visits').delete().lt('created_at', new Date(Date.now() - 365 * DAY).toISOString());
  const photos = await cleanMaintenance();
  return `maintenance: ${removed.absences} canceladas borradas, ${removed.files} archivos, ${photos} fotos de mantenimiento`;
}

/**
 * Hourly (pg_cron): the students noted for alerts, pickups and turns are kept only 24 hours, and so are the
 * notices that named them. The alerts themselves stay, without the name; the services keep their turns.
 */
async function purge(): Promise<string> {
  const now = new Date().toISOString();
  const dayAgo = new Date(Date.now() - DAY).toISOString();
  const { count: students, error } = await db.from('students').delete({ count: 'exact' }).lt('expires_at', now);
  if (error) throw new Error(error.message);
  let notices = 0;
  for (const prefix of ['#/alerts/%', '#/turns/%']) {
    const { count, error: noticeError } = await db
      .from('notifications')
      .delete({ count: 'exact' })
      .like('link', prefix)
      .lt('created_at', dayAgo);
    if (noticeError) throw new Error(noticeError.message);
    notices += count ?? 0;
  }
  return `purge: ${students ?? 0} estudiantes, ${notices} avisos`;
}

serve(async (req) => {
  // Only the database calls this function (private.dispatch_outbox), with the secret from app_settings.
  const secret = await setting<{ value: string }>('notify_secret');
  if (!secret?.value || req.headers.get('x-notify-secret') !== secret.value) return json({ error: 'No autorizado.' }, 401);
  let id: unknown;
  try {
    ({ id } = await req.json());
  } catch {
    return json({ error: 'Solicitud no válida.' }, 400);
  }
  if (!Number.isInteger(id)) return json({ error: 'Solicitud no válida.' }, 400);

  // Claim the row atomically so each event is delivered at most once.
  const { data: job } = await db
    .from('outbox')
    .update({ processed_at: new Date().toISOString() })
    .eq('id', id)
    .is('processed_at', null)
    .select()
    .maybeSingle();
  if (!job) return json({ skipped: true });

  let result: string;
  try {
    result =
      job.kind === 'push'
        ? await handlePush(job.payload)
        : job.kind === 'maintenance'
          ? await maintenance(job.id)
          : job.kind === 'purge'
            ? await purge()
            : await handleTeams(job.school_id, job.payload);
  } catch (err) {
    result = `error: ${(err as Error).message}`;
  }
  await db.from('outbox').update({ result: result.slice(0, 500) }).eq('id', id);
  return json({ ok: true, result });
});
