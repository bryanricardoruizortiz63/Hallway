-- 1. Roles with «Historial del personal» couldn't be saved: the database didn't know that permission. Fixed, with
--    three new permissions (off until the Admin turns them on in Roles):
--      absence_search      search the staff's absences by name, dates and group, and save them as a PDF or image
--      turn_search         search the turns of today and earlier days
--      own_absence_search  search one's own absences by dates
-- 2. Each service has hours: outside them (or on a day without classes) nobody can ask for a turn. By default the
--    school's class hours; whoever has «Configurar Turnos» changes them per service. Whoever attends the service can
--    still note one.

alter table public.school_roles drop constraint if exists school_roles_permissions_check;
alter table public.school_roles add constraint school_roles_permissions_check
  check (permissions <@ array['absences', 'register', 'staff', 'settings', 'services', 'messages', 'reports', 'live',
    'calendar', 'rooms', 'security', 'visitors', 'maintenance', 'summary', 'history',
    'absence_search', 'turn_search', 'own_absence_search']::text[]);

-- ---- Service hours ----------------------------------------------------------------------------------------------

alter table public.school_services add column if not exists open_from time;
alter table public.school_services add column if not exists open_until time;
alter table public.school_services drop constraint if exists school_services_hours_check;
alter table public.school_services add constraint school_services_hours_check
  check ((open_from is null) = (open_until is null) and (open_from is null or open_from < open_until));

/** The service's hours: its own, or the school's class hours. */
create or replace function private.service_hours(s public.school_services)
returns table (opens time, closes time)
language sql stable security definer set search_path = ''
as $$
  select coalesce(s.open_from, st.day_start, '07:40'), coalesce(s.open_until, st.day_end, '15:30')
  from (select 1) x left join public.school_settings st on st.school_id = s.school_id
$$;

/** Why the service can't take turns right now (null: it can). */
create or replace function private.service_closed(s public.school_services)
returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  st public.school_settings;
  v_local timestamp;
  v_opens time;
  v_closes time;
begin
  select * into st from public.school_settings x where x.school_id = s.school_id;
  v_local := now() at time zone coalesce(st.time_zone, 'America/Puerto_Rico');
  select h.opens, h.closes into v_opens, v_closes from private.service_hours(s) h;
  if not (extract(isodow from v_local)::int = any(coalesce(st.school_days, '{1,2,3,4,5}'))) or exists (
    select 1 from public.school_closures c
    where c.school_id = s.school_id and v_local::date between c.start_date and c.end_date
  ) then
    return format('Hoy no hay clases: %s no recibe turnos.', s.name);
  end if;
  if v_local::time < v_opens or v_local::time >= v_closes then
    return format('%s recibe turnos de %s a %s. Ahora está fuera de su horario.', s.name,
      private.time_text(v_opens), private.time_text(v_closes));
  end if;
  return null;
end;
$$;

/** Nobody asks for a turn outside the service's hours (whoever attends the service can still note one). */
create or replace function private.check_service_hours()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  s public.school_services;
  v_why text;
begin
  select * into s from public.school_services x where x.id = new.service_id;
  v_why := private.service_closed(s);
  if v_why is not null and not exists (
    select 1 from public.profiles p where p.id = new.created_by and private.roles_of(p) && s.roles
  ) then
    raise exception '%', v_why;
  end if;
  return new;
end;
$$;
drop trigger if exists service_requests_hours on public.service_requests;
create trigger service_requests_hours before insert on public.service_requests
  for each row execute function private.check_service_hours();

/** «Configurar Turnos»: a service's own hours (both null: the school's class hours). */
create or replace function public.set_service_hours(p_id bigint, p_from time, p_until time)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
begin
  if not private.can(me, 'services') then raise exception 'No tienes permiso para cambiar los servicios.'; end if;
  if (p_from is null) <> (p_until is null) then raise exception 'Indica desde qué hora y hasta qué hora recibe turnos.'; end if;
  if p_from is not null and p_from >= p_until then raise exception 'La hora final debe ser después de la inicial.'; end if;
  update public.school_services set open_from = p_from, open_until = p_until
  where id = p_id and school_id = me.school_id;
  if not found then raise exception 'No se encontró el servicio.'; end if;
end;
$$;
revoke execute on function public.set_service_hours(bigint, time, time) from public, anon;
grant execute on function public.set_service_hours(bigint, time, time) to authenticated;

-- Same as before, with the hours: its own (open_from, open_until), the ones that apply and why it's closed now.
create or replace function public.services_overview()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'mode', s.mode, 'arrive_minutes', s.arrive_minutes,
        'roles', to_jsonb(s.roles), 'reasons', to_jsonb(s.reasons), 'active', s.active, 'keep_open', s.keep_open,
        'open_from', to_char(s.open_from, 'HH24:MI'), 'open_until', to_char(s.open_until, 'HH24:MI'),
        'opens', (select to_char(h.opens, 'HH24:MI') from private.service_hours(s) h),
        'closes', (select to_char(h.closes, 'HH24:MI') from private.service_hours(s) h),
        'closed_reason', private.service_closed(s),
        'serves', private.roles_of(me) && s.roles,
        'waiting', (select count(*) from public.service_requests x where x.service_id = s.id and x.status = 'waiting'),
        'staff', (
          select coalesce(jsonb_agg(jsonb_build_object(
              'id', p.id, 'name', p.full_name, 'status', private.staff_status(st),
              'until', case when private.staff_status(st) <> 'available' then st.until end,
              -- Absences around today (the app compares them with the phone's clock): who is out, all day or for a while.
              'absences', (
                select coalesce(jsonb_agg(jsonb_build_object(
                    'start_date', a.start_date, 'end_date', a.end_date, 'partial', a.partial,
                    'start_time', a.start_time, 'end_time', a.end_time) order by a.start_date), '[]'::jsonb)
                from public.absences a
                where a.user_id = p.id and a.status <> 'cancelled'
                  and a.end_date >= current_date - 1 and a.start_date <= current_date + 1))
            order by p.full_name), '[]'::jsonb)
          from public.profiles p
          left join public.service_staff_status st on st.user_id = p.id
          where p.school_id = s.school_id and p.active and private.roles_of(p) && s.roles)
      ) order by s.position, s.name)
    from public.school_services s
    where s.school_id = me.school_id and (s.active or private.can(me, 'services'))
  ), '[]'::jsonb);
end;
$$;

-- ---- Searches -------------------------------------------------------------------------------------------------

/**
 * «Buscar ausencias» (permission absence_search, or whoever already sees everyone's absences): by the person's
 * name, dates (any absence that touches them) and group (the person's groups or the groups covered). Never the
 * reason: only when and who covered.
 */
create or replace function public.search_absences(p_name text, p_from date, p_to date, p_group text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_group text := nullif(btrim(coalesce(p_group, '')), '');
begin
  if not (private.can(me, 'absence_search') or private.can(me, 'absences')) then
    raise exception 'No tienes permiso para buscar ausencias.';
  end if;
  return coalesce((
    select jsonb_agg(x order by x->>'start_date' desc, x->>'employee_name')
    from (
      select jsonb_build_object(
        'id', a.id, 'employee_name', p.full_name, 'employee_position', p.position, 'groups', to_jsonb(p.groups),
        'start_date', a.start_date, 'end_date', a.end_date, 'partial', a.partial,
        'start_time', to_char(a.start_time, 'HH24:MI'), 'end_time', to_char(a.end_time, 'HH24:MI'),
        'status', a.status, 'created_at', a.created_at,
        'covers', (select coalesce(jsonb_agg(c ->> 'name'), '[]'::jsonb) from jsonb_array_elements(coalesce(a.covers, '[]'::jsonb)) c),
        'cover_groups', (select coalesce(jsonb_agg(distinct g), '[]'::jsonb)
          from jsonb_array_elements(coalesce(a.covers, '[]'::jsonb)) c, jsonb_array_elements_text(coalesce(c -> 'groups', '[]'::jsonb)) g),
        'no_cover', a.no_cover) as x
      from public.absences a
      join public.profiles p on p.id = a.user_id
      where a.school_id = me.school_id and a.status <> 'cancelled'
        and (p_from is null or a.end_date >= p_from) and (p_to is null or a.start_date <= p_to)
        and (v_name is null or p.full_name ilike '%' || v_name || '%')
        and (v_group is null or v_group = any(p.groups) or exists (
          select 1 from jsonb_array_elements(coalesce(a.covers, '[]'::jsonb)) c
          where coalesce(c -> 'groups', '[]'::jsonb) ? v_group))
      limit 500
    ) t(x)
  ), '[]'::jsonb);
end;
$$;
revoke execute on function public.search_absences(text, date, date, text) from public, anon;
grant execute on function public.search_absences(text, date, date, text) to authenticated;

/** «Buscar mis ausencias» (permission own_absence_search): one's own, by dates. */
create or replace function public.search_my_absences(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
begin
  if not private.can(me, 'own_absence_search') then raise exception 'No tienes permiso para buscar tus ausencias.'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'id', a.id, 'employee_name', me.full_name, 'employee_position', me.position,
        'start_date', a.start_date, 'end_date', a.end_date, 'partial', a.partial,
        'start_time', to_char(a.start_time, 'HH24:MI'), 'end_time', to_char(a.end_time, 'HH24:MI'),
        'status', a.status, 'created_at', a.created_at, 'category', a.category,
        'covers', (select coalesce(jsonb_agg(c ->> 'name'), '[]'::jsonb) from jsonb_array_elements(coalesce(a.covers, '[]'::jsonb)) c),
        'no_cover', a.no_cover)
      order by a.start_date desc)
    from public.absences a
    where a.user_id = me.id
      and (p_from is null or a.end_date >= p_from) and (p_to is null or a.start_date <= p_to)
  ), '[]'::jsonb);
end;
$$;
revoke execute on function public.search_my_absences(date, date) from public, anon;
grant execute on function public.search_my_absences(date, date) to authenticated;

/** «Buscar turnos» (permission turn_search, or Admin and Director(a)): today's and earlier days' turns. */
create or replace function public.search_turns(p_from date, p_to date, p_name text, p_service bigint, p_group text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_group text := nullif(btrim(coalesce(p_group, '')), '');
  v_tz text := coalesce((select st.time_zone from public.school_settings st where st.school_id = me.school_id), 'America/Puerto_Rico');
begin
  if not (private.can(me, 'turn_search') or private.history_full(me)) then
    raise exception 'No tienes permiso para buscar turnos.';
  end if;
  return coalesce((
    select jsonb_agg(x order by x->>'created_at' desc)
    from (
      select jsonb_build_object(
        'id', r.id, 'service_id', s.id, 'service_name', s.name, 'service_mode', s.mode,
        'student_name', r.student_name, 'group_name', r.group_name, 'room', r.room, 'severity', r.severity,
        'status', r.status, 'outcome', r.outcome, 'reason', d.reason,
        'created_at', r.created_at, 'closed_at', r.closed_at,
        'created_by_name', r.created_by_name, 'handled_by_name', r.handled_by_name) as x
      from public.service_requests r
      join public.school_services s on s.id = r.service_id
      left join public.service_request_details d on d.request_id = r.id
      where r.school_id = me.school_id
        and (p_from is null or (r.created_at at time zone v_tz)::date >= p_from)
        and (p_to is null or (r.created_at at time zone v_tz)::date <= p_to)
        and (p_service is null or r.service_id = p_service)
        and (v_group is null or r.group_name = v_group)
        and (v_name is null or r.student_name ilike '%' || v_name || '%' or r.created_by_name ilike '%' || v_name || '%'
             or d.reason ilike '%' || v_name || '%')
      order by r.created_at desc
      limit 500
    ) t(x)
  ), '[]'::jsonb);
end;
$$;
revoke execute on function public.search_turns(date, date, text, bigint, text) from public, anon;
grant execute on function public.search_turns(date, date, text, bigint, text) to authenticated;

-- Whoever searches turns can also open them (same as in 20261202000066, with turn_search).
create or replace function private.sees_all_turns()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select private.history_full(p) or private.can(p, 'live') or private.can(p, 'summary')
    or private.can(p, 'turn_search')
    from public.profiles p where p.id = auth.uid() and p.active), false)
$$;
