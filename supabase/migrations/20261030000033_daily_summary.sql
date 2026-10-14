-- Resumen del día, a permission of its own in Roles y permisos («Resumen del día», summary):
--   * Whoever has it gets a notice when classes end on a school day (in the school's time zone; never on a day
--     without classes): how many were absent and how many weren't covered, the services' turns, the maintenance
--     left and who is absent the next school day. The notice opens the whole summary.
--   * The summary (daily_summary) opens for any of the last 60 days: the staff's absences with who covered them (or
--     «Nadie cubrirá»), the services' turns in numbers (never a student's name or a note), «No ha llegado» alerts,
--     pickups, relief, visits, maintenance and the next school day (absences and the conference room).
--   * It comes with «Ver y confirmar las ausencias de todos» (absences), like the reports. The dirección gets it; any
--     role can be given it. The Administración account can open it but gets no notice.

-- ---------------------------------------------------------------------------
-- Permission
-- ---------------------------------------------------------------------------

alter table public.school_roles drop constraint school_roles_permissions_check;
alter table public.school_roles add constraint school_roles_permissions_check
  check (permissions <@ array['absences', 'register', 'staff', 'settings', 'services', 'messages', 'reports', 'live', 'calendar', 'rooms', 'security', 'visitors', 'maintenance', 'summary']::text[]);
-- The summary has everyone's absences, like the reports.
alter table public.school_roles drop constraint school_roles_permissions_check1;
alter table public.school_roles add constraint school_roles_permissions_check1
  check ('absences' = any(permissions) or not (permissions && array['staff', 'reports', 'register', 'summary']));

update public.school_roles set permissions = permissions || 'summary'::text
where key in ('admin', 'director') and 'absences' = any(permissions) and not 'summary' = any(permissions);

create or replace function private.add_default_roles(p_school uuid)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.school_roles (school_id, key, name, permissions, coverage, system, position) values
    (p_school, 'admin', 'Administración', array['absences', 'register', 'staff', 'settings', 'services', 'messages', 'reports', 'live', 'calendar', 'rooms', 'security', 'visitors', 'maintenance', 'summary'], false, true, 0),
    (p_school, 'director', 'Director(a)', array['absences', 'staff', 'settings', 'services', 'messages', 'reports', 'live', 'calendar', 'rooms', 'security', 'visitors', 'summary'], true, false, 10),
    (p_school, 'secretary', 'Secretaría', array['absences', 'live', 'calendar', 'rooms', 'security', 'visitors'], true, false, 20),
    (p_school, 'teacher', 'Maestro(a)', '{}', true, false, 30),
    (p_school, 'facultad', 'Facultad', '{}', true, false, 40),
    (p_school, 'enfermeria', 'Enfermería', '{}', false, false, 50),
    (p_school, 'trabajo_social', 'Trabajo Social', '{}', false, false, 55),
    (p_school, 'mantenimiento', 'Mantenimiento', array['maintenance'], false, false, 60),
    (p_school, 'it', 'Coordinador(a) de IT', '{}', false, false, 65),
    (p_school, 'seguridad', 'Seguridad', array['security', 'visitors'], false, false, 70)
  on conflict do nothing
$$;

-- ---------------------------------------------------------------------------
-- The summary
-- ---------------------------------------------------------------------------

/** The days a school already sent its summary: once a day. Only the server uses it. */
create table public.daily_summaries (
  school_id uuid not null references public.schools on delete cascade,
  day date not null,
  sent_at timestamptz not null default now(),
  primary key (school_id, day)
);
alter table public.daily_summaries enable row level security;
revoke all on public.daily_summaries from anon, authenticated;

/** The next school day after p_day (a school day of the week, not a day without classes), within two weeks. */
create or replace function private.next_school_day(p_school uuid, p_day date)
returns date
language sql stable security definer set search_path = ''
as $$
  select d::date
  from generate_series((p_day + 1)::timestamp, (p_day + 14)::timestamp, interval '1 day') d
  where extract(isodow from d)::smallint = any(coalesce(
      (select s.school_days from public.school_settings s where s.school_id = p_school), '{1,2,3,4,5}'::smallint[]))
    and not exists (select 1 from public.school_closures c
                    where c.school_id = p_school and d::date between c.start_date and c.end_date)
  order by 1
  limit 1
$$;

/**
 * The staff's absences on a day, by name: [{ id, name, role, partial, start_time, end_time, category, status,
 * covers (who covers that day), unconfirmed (who covers that day and hasn't tapped «Recibido»), no_cover,
 * needs_cover }]. Never the reason.
 */
create or replace function private.summary_absences(p_school uuid, p_day date)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'name', p.full_name, 'role', r.name, 'partial', a.partial,
      'start_time', to_char(a.start_time, 'HH24:MI'), 'end_time', to_char(a.end_time, 'HH24:MI'),
      'category', a.category, 'status', a.status,
      'covers', coalesce(
        (select jsonb_agg(distinct e.value->>'name') from jsonb_array_elements(a.covers) e
         where private.cover_on(a, e.value, p_day)),
        case when a.covers = '[]'::jsonb and a.substitute is not null then jsonb_build_array(a.substitute) else '[]'::jsonb end),
      'unconfirmed', coalesce(
        (select jsonb_agg(distinct e.value->>'name') from jsonb_array_elements(a.covers) e
         where private.cover_on(a, e.value, p_day) and e.value->>'substitute_id' is not null and e.value ? 'set_by'
           and e.value->>'received_at' is null),
        '[]'::jsonb),
      'no_cover', a.no_cover,
      'needs_cover', coalesce(r.coverage, p.role <> 'admin'))
    order by p.full_name), '[]'::jsonb)
  from public.absences a
  join public.profiles p on p.id = a.user_id
  left join public.school_roles r on r.school_id = a.school_id and r.key = p.role
  where a.school_id = p_school and a.status <> 'cancelled' and p_day between a.start_date and a.end_date
$$;

/** Everything of one school day, in the school's time zone. Turns, alerts and visits only in numbers. */
create or replace function private.summary_of(p_school uuid, p_day date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  st record;
  v_from timestamptz;
  v_to timestamptz;
  v_next date := private.next_school_day(p_school, p_day);
  v_closure text;
begin
  select coalesce(s.time_zone, 'America/Puerto_Rico') as tz, coalesce(s.day_end, '15:30'::time) as day_end,
    coalesce(s.school_days, '{1,2,3,4,5}'::smallint[]) as school_days
  into st
  from (select 1) one left join public.school_settings s on s.school_id = p_school;
  v_from := p_day::timestamp at time zone st.tz;
  v_to := (p_day + 1)::timestamp at time zone st.tz;
  select c.name into v_closure from public.school_closures c
  where c.school_id = p_school and p_day between c.start_date and c.end_date
  order by c.start_date limit 1;

  return jsonb_build_object(
    'day', p_day,
    'school_day', extract(isodow from p_day)::smallint = any(st.school_days) and v_closure is null,
    'closure', v_closure,
    'day_end', to_char(st.day_end, 'HH24:MI'),
    'absences', private.summary_absences(p_school, p_day),
    'services', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', s.id, 'name', s.name, 'mode', s.mode, 'requested', x.requested, 'done', x.done,
          'cancelled', x.cancelled, 'late', x.late, 'return_late', x.return_late, 'referred', x.referred,
          'picked_up', x.picked_up, 'wait', x.wait, 'open', x.open)
        order by s.position, s.name)
      from public.school_services s
      cross join lateral (
        select count(*) as requested,
          count(*) filter (where r.status = 'done') as done,
          count(*) filter (where r.status = 'cancelled') as cancelled,
          count(*) filter (where r.late_at is not null) as late,
          count(*) filter (where r.return_late_at is not null) as return_late,
          count(*) filter (where r.outcome = 'referred') as referred,
          count(*) filter (where r.outcome = 'picked_up') as picked_up,
          round(avg(extract(epoch from coalesce(r.called_at, r.on_the_way_at, r.arrived_at) - r.created_at) / 60))::int as wait,
          count(*) filter (where r.status not in ('done', 'cancelled')) as open
        from public.service_requests r
        where r.service_id = s.id and r.created_at >= v_from and r.created_at < v_to
      ) x
      where s.school_id = p_school and (s.active or x.requested > 0)
    ), '[]'::jsonb),
    'alerts', (
      select jsonb_build_object('missing', count(*), 'unresolved', count(*) filter (where a.resolved_at is null))
      from public.student_alerts a
      where a.school_id = p_school and a.created_at >= v_from and a.created_at < v_to),
    'pickups', (
      select count(*) from public.student_pickups k
      where k.school_id = p_school and k.delivered_at >= v_from and k.delivered_at < v_to),
    'relief', (
      select count(*) from public.relief_requests x
      where x.school_id = p_school and x.created_at >= v_from and x.created_at < v_to),
    'visits', (
      select count(*) from public.visits v
      where v.school_id = p_school and v.created_at >= v_from and v.created_at < v_to),
    'maintenance', (
      select jsonb_build_object(
        'requested', count(*) filter (where m.created_at >= v_from and m.created_at < v_to),
        'done', count(*) filter (where m.done_at >= v_from and m.done_at < v_to),
        'open', count(*) filter (where m.status in ('pending', 'on_the_way') and m.created_at < v_to),
        'urgent', count(*) filter (where m.status in ('pending', 'on_the_way') and m.created_at < v_to and m.urgency = 3))
      from public.maintenance_requests m
      where m.school_id = p_school),
    'next_day', v_next,
    'next_absences', case when v_next is null then '[]'::jsonb else private.summary_absences(p_school, v_next) end,
    'next_rooms', (
      select count(*) from public.room_bookings b
      where b.school_id = p_school and b.day = v_next and b.status = 'approved'),
    'rooms_pending', (
      select count(*) from public.room_bookings b
      where b.school_id = p_school and b.status = 'pending' and b.day > p_day)
  );
end;
$$;

/** The notice: "3 ausencias (1 sin cubrir) · 12 turnos (1 no llegó a tiempo) · 2 de mantenimiento pendientes · Mañana faltan 2." */
create or replace function private.summary_text(j jsonb)
returns text
language sql immutable set search_path = ''
as $$
  with t as (
    select
      jsonb_array_length(j->'absences') as absent,
      (select count(*) from jsonb_array_elements(j->'absences') a
       where (a->>'needs_cover')::boolean and jsonb_array_length(a->'covers') = 0 and a->>'no_cover' is null) as uncovered,
      (select coalesce(sum((s->>'requested')::int), 0) from jsonb_array_elements(j->'services') s) as turns,
      (select coalesce(sum((s->>'late')::int), 0) from jsonb_array_elements(j->'services') s) as late,
      (j->'maintenance'->>'open')::int as maint,
      jsonb_array_length(j->'next_absences') as next_absent,
      (j->>'next_day')::date as next_day,
      (j->>'day')::date as day
  )
  select concat_ws(' · ',
      case when absent = 0 then 'Nadie del personal faltó'
        else absent || case when absent = 1 then ' ausencia' else ' ausencias' end
          || case when uncovered > 0 then ' (' || uncovered || ' sin cubrir)' else '' end end,
      case when turns = 0 then 'Sin turnos'
        else turns || case when turns = 1 then ' turno' else ' turnos' end
          || case when late > 0 then ' (' || late || ' no ' || case when late = 1 then 'llegó' else 'llegaron' end || ' a tiempo)' else '' end end,
      case when maint > 0 then maint || ' de mantenimiento ' || case when maint = 1 then 'pendiente' else 'pendientes' end end,
      case when next_day is not null then
        case when next_day = day + 1 then 'Mañana'
          else 'El ' || (array['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'])[extract(isodow from next_day)::int] end
        || case when next_absent = 0 then ' no falta nadie' when next_absent = 1 then ' falta 1' else ' faltan ' || next_absent end
      end) || '.'
  from t
$$;

/** The summary of a day (by default today, in the school's time zone; up to 60 days back), with «Resumen del día». */
create or replace function public.daily_summary(p_day date default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_today date;
  v_day date;
begin
  if not private.can(me, 'summary') then
    raise exception 'No tienes permiso para ver el resumen del día.';
  end if;
  v_today := (now() at time zone coalesce(
    (select s.time_zone from public.school_settings s where s.school_id = me.school_id), 'America/Puerto_Rico'))::date;
  v_day := coalesce(p_day, v_today);
  if v_day > v_today or v_day < v_today - 60 then
    raise exception 'Elige un día de los últimos 60.';
  end if;
  return private.summary_of(me.school_id, v_day);
end;
$$;

/**
 * Every 5 minutes (pg_cron): when classes end on a school day (in the school's time zone, up to 3 hours later),
 * whoever has «Resumen del día» gets the day's summary, once. The Administración account doesn't.
 */
create or replace function private.send_daily_summaries()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  s record;
  v_local timestamp;
  v_day date;
  v_to uuid[];
  v_sum jsonb;
begin
  for s in
    select x.id, coalesce(st.time_zone, 'America/Puerto_Rico') as tz, coalesce(st.day_end, '15:30'::time) as day_end,
      coalesce(st.school_days, '{1,2,3,4,5}'::smallint[]) as school_days
    from public.schools x
    left join public.school_settings st on st.school_id = x.id
  loop
    v_local := now() at time zone s.tz;
    v_day := v_local::date;
    continue when not extract(isodow from v_day)::smallint = any(s.school_days)
      or v_local < v_day + s.day_end or v_local >= v_day + s.day_end + interval '3 hours'
      or exists (select 1 from public.school_closures c where c.school_id = s.id and v_day between c.start_date and c.end_date);
    v_to := array(
      select p.id from public.profiles p
      join public.school_roles r on r.school_id = p.school_id and r.key = p.role
      where p.school_id = s.id and p.active and p.role <> 'admin' and 'summary' = any(r.permissions));
    continue when cardinality(v_to) = 0;
    insert into public.daily_summaries (school_id, day) values (s.id, v_day) on conflict do nothing;
    continue when not found;
    v_sum := private.summary_of(s.id, v_day);
    perform private.notify_tagged(
      v_to, '📊 Resumen del día · ' || private.fmt_date(v_day), private.summary_text(v_sum),
      '#/summary/' || to_char(v_day, 'YYYY-MM-DD'), 'summary-' || to_char(v_day, 'YYYY-MM-DD'), false);
  end loop;
end;
$$;

revoke execute on function private.next_school_day(uuid, date), private.summary_absences(uuid, date),
  private.summary_of(uuid, date), private.summary_text(jsonb), private.send_daily_summaries()
  from public, anon, authenticated;
revoke execute on function public.daily_summary(date) from public, anon;
grant execute on function public.daily_summary(date) to authenticated;

select cron.schedule('hallway-daily-summary', '*/5 * * * *', $job$select private.send_daily_summaries()$job$);
