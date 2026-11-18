-- Turnos confidenciales: el motivo, la nota y cómo terminó un turno solo los ven quien atiende el servicio, quien pidió el
-- turno, Director(a) y Admin. Los demás que ven turnos (los maestros del grupo, Secretaría por En vivo, IT por Resumen
-- del día o Buscar turnos) ven el estudiante, el servicio y en qué paso va, pero no el motivo ni la nota, y del
-- resultado solo lo que no dice nada del estudiante (regresó al salón, se canceló, lo cerró el sistema).
--   * service_request_details (motivo, nota, resolución): su lectura directa, igual.
--   * service_requests.outcome: ya no se lee directo; la vista y las funciones lo dan con private.turn_outcome().
--   * service_request_events: el paso «Cerró el turno: …» solo para quien ve el detalle.
--   * En vivo, Resumen del día, Buscar turnos y los documentos sellados de turnos: el motivo y el resultado van vacíos
--     para quien no ve el detalle. Los números del día (cuántos referidos, recogidos…) siguen: no dicen quién.
-- También: el tablero En vivo da el id de cada persona del servicio, para «Atendiendo un turno» (20261221000085).

/** Whether I see this turn's details: I attend its service, I asked for it, or I'm Director(a) or Admin. */
create or replace function private.turn_details_ok(p_service_id bigint, p_created_by uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select auth.uid() = p_created_by
    or private.serves(p_service_id)
    or coalesce((select private.history_full(p) from public.profiles p where p.id = auth.uid() and p.active), false)
$$;

/** How a turn ended, as I may see it: the whole result if I see its details; else only what says nothing about the student. */
create or replace function private.turn_outcome_shown(p_outcome text, p_ok boolean)
returns text
language sql immutable set search_path = ''
as $$
  select case when p_ok or p_outcome in ('returned', 'cancelled', 'expired', 'unconfirmed', 'attended') then p_outcome end
$$;

/** A turn's result for the open account (see turn_outcome_shown). */
create or replace function private.turn_outcome(p_id bigint)
returns text
language sql stable security definer set search_path = ''
as $$
  select private.turn_outcome_shown(r.outcome, private.turn_details_ok(r.service_id, r.created_by))
  from public.service_requests r where r.id = p_id
$$;

-- The reason, the note and the resolution: whoever attends the service, Director(a) and Admin, and whoever asked for it
-- (while it's open or for 24 hours, as before). Before, En vivo, Resumen del día and Buscar turnos also saw them.
drop policy if exists "Ver motivo del turno" on public.service_request_details;
create policy "Ver motivo del turno" on public.service_request_details for select to authenticated using (
  school_id = (select private.my_school_id())
  and (
    private.serves(service_id)
    or coalesce((select private.history_full(p) from public.profiles p where p.id = (select auth.uid()) and p.active), false)
    or (created_by = (select auth.uid()) and (
      created_at > now() - interval '24 hours'
      or exists (select 1 from public.service_requests r where r.id = service_request_details.request_id and r.status not in ('done', 'cancelled'))))
  )
);

-- The steps of a turn: the last one («Cerró el turno: lo refirió…») only for whoever sees its details.
drop policy if exists "events of the turns one sees" on public.service_request_events;
create policy "events of the turns one sees" on public.service_request_events for select to authenticated using (
  exists (
    select 1 from public.service_requests r
    where r.id = service_request_events.request_id
      and (service_request_events.kind <> 'done' or private.turn_details_ok(r.service_id, r.created_by))
  )
);

-- The result isn't read straight from the table any more: the view gives it through private.turn_outcome().
create or replace view public.service_requests_v with (security_invoker = true) as
select r.id, r.school_id, r.service_id, r.student_id, r.student_name, r.student_key, r.group_name, r.room, r.severity,
  r.status, private.turn_outcome(r.id) as outcome, r.teacher_id, r.teacher_name, r.created_by, r.created_by_name,
  r.created_at, r.handled_by, r.handled_by_name, r.out_of_order, r.called_at, r.sent_at, r.due_at, r.late_at,
  r.arrived_at, r.on_the_way_at, r.returning_at, r.closed_at, r.closed_by_name, s.name as service_name,
  case when s.mode = 'either' then coalesce(r.flow, 'either') else s.mode end as service_mode,
  d.reason, d.note,
  case when r.status = 'waiting' then private.turn_level(r.severity::integer, r.created_at) else null::integer end as level,
  private.turn_position(r.id) as "position", r.return_late_at, d.resolution, r.return_check_at, r.received_at,
  r.received_by_name
from public.service_requests r
join public.school_services s on s.id = r.service_id
left join public.service_request_details d on d.request_id = r.id;

do $$
declare
  v_cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into v_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'service_requests' and column_name <> 'outcome';
  execute 'revoke select on public.service_requests from authenticated, anon';
  execute format('grant select (%s) on public.service_requests to authenticated', v_cols);
end;
$$;

-- Same as before, with the reason and the result only for whoever sees the turn's details.
create or replace function public.day_turns(p_service_id bigint, p_from timestamptz, p_to timestamptz)
returns table (id bigint, student_name text, group_name text, room text, severity smallint, level integer, status text,
  outcome text, reason text, resolution text, created_by_name text, teacher_name text, handled_by_name text,
  closed_by_name text, out_of_order boolean, created_at timestamptz, called_at timestamptz, sent_at timestamptz,
  arrived_at timestamptz, on_the_way_at timestamptz, returning_at timestamptz, closed_at timestamptz, late_at timestamptz,
  return_late_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
begin
  if not exists (select 1 from public.school_services s where s.id = p_service_id and s.school_id = me.school_id) then
    raise exception 'No se encontró el servicio.';
  end if;
  if not (private.can(me, 'summary') or private.can(me, 'live') or private.serves(p_service_id)) then
    raise exception 'No tienes permiso para ver el resumen del día.';
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '30 hours'
    or p_from < now() - interval '61 days' then
    raise exception 'Elige un día de los últimos 60.';
  end if;
  return query
    select r.id, r.student_name, r.group_name, r.room, r.severity,
      case when r.status = 'waiting' then private.turn_level(r.severity, r.created_at) else r.severity::int end,
      r.status, private.turn_outcome_shown(r.outcome, k.ok), case when k.ok then d.reason end, case when k.ok then d.resolution end,
      r.created_by_name, r.teacher_name, r.handled_by_name,
      r.closed_by_name, r.out_of_order, r.created_at, r.called_at, r.sent_at, r.arrived_at, r.on_the_way_at,
      r.returning_at, r.closed_at, r.late_at, r.return_late_at
    from public.service_requests r
    cross join lateral (select private.turn_details_ok(r.service_id, r.created_by) as ok) k
    left join public.service_request_details d on d.request_id = r.id
    where r.service_id = p_service_id and r.created_at >= p_from and r.created_at < p_to
    order by r.created_at;
end;
$$;

create or replace function public.live_turns(p_service_id bigint, p_since timestamptz)
returns table (id bigint, student_name text, group_name text, room text, severity smallint, level integer, status text,
  outcome text, reason text, resolution text, created_by_name text, teacher_name text, handled_by_name text,
  closed_by_name text, out_of_order boolean, created_at timestamptz, called_at timestamptz, sent_at timestamptz,
  arrived_at timestamptz, on_the_way_at timestamptz, returning_at timestamptz, closed_at timestamptz, late_at timestamptz,
  return_late_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_since timestamptz := greatest(coalesce(p_since, now() - interval '12 hours'), now() - interval '36 hours');
begin
  if not exists (select 1 from public.school_services s where s.id = p_service_id and s.school_id = me.school_id) then
    raise exception 'No se encontró el servicio.';
  end if;
  if not (private.can(me, 'live') or private.serves(p_service_id)) then
    raise exception 'No tienes permiso para ver el tablero en vivo.';
  end if;
  return query
    select r.id, r.student_name, r.group_name, r.room, r.severity,
      case when r.status = 'waiting' then private.turn_level(r.severity, r.created_at) else r.severity::int end,
      r.status, private.turn_outcome_shown(r.outcome, k.ok), case when k.ok then d.reason end, case when k.ok then d.resolution end,
      r.created_by_name, r.teacher_name, r.handled_by_name,
      r.closed_by_name, r.out_of_order, r.created_at, r.called_at, r.sent_at, r.arrived_at, r.on_the_way_at,
      r.returning_at, r.closed_at, r.late_at, r.return_late_at
    from public.service_requests r
    cross join lateral (select private.turn_details_ok(r.service_id, r.created_by) as ok) k
    left join public.service_request_details d on d.request_id = r.id
    where r.service_id = p_service_id
      and (r.created_at >= v_since or r.status not in ('done', 'cancelled'))
    order by r.created_at
    limit 500;
end;
$$;

create or replace function public.live_turn(p_id bigint)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  r public.service_requests;
  v jsonb;
  v_ok boolean;
begin
  select * into r from public.service_requests x where x.id = p_id and x.school_id = me.school_id;
  if r.id is null then
    raise exception 'No se encontró el turno.';
  end if;
  if not (private.can(me, 'live') or private.can(me, 'summary') or private.serves(r.service_id)) then
    raise exception 'No tienes permiso para ver este turno.';
  end if;
  v_ok := private.turn_details_ok(r.service_id, r.created_by);
  select jsonb_build_object(
    'id', r.id, 'service_id', r.service_id, 'service_name', s.name, 'service_mode', case when s.mode = 'either' then coalesce(r.flow, 'either') else s.mode end,
    'student_name', r.student_name, 'group_name', r.group_name, 'room', r.room,
    'severity', r.severity,
    'level', case when r.status = 'waiting' then private.turn_level(r.severity, r.created_at) else r.severity::int end,
    'position', case when r.status = 'waiting' then private.turn_position(r.id) end,
    'status', r.status, 'outcome', private.turn_outcome_shown(r.outcome, v_ok),
    'reason', case when v_ok then d.reason end, 'note', case when v_ok then d.note end, 'resolution', case when v_ok then d.resolution end,
    'details_hidden', not v_ok,
    'created_by_name', r.created_by_name, 'teacher_name', r.teacher_name, 'handled_by_name', r.handled_by_name,
    'closed_by_name', r.closed_by_name, 'out_of_order', r.out_of_order,
    'created_at', r.created_at, 'called_at', r.called_at, 'sent_at', r.sent_at, 'due_at', r.due_at, 'late_at', r.late_at,
    'arrived_at', r.arrived_at, 'on_the_way_at', r.on_the_way_at, 'returning_at', r.returning_at,
    'return_late_at', r.return_late_at, 'closed_at', r.closed_at
  )
  into v
  from public.school_services s
  left join public.service_request_details d on d.request_id = r.id
  where s.id = r.service_id;
  return v;
end;
$$;

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
        'status', r.status, 'outcome', private.turn_outcome_shown(r.outcome, k.ok), 'reason', case when k.ok then d.reason end,
        'created_at', r.created_at, 'closed_at', r.closed_at, 'closed_by_name', r.closed_by_name,
        'created_by_name', r.created_by_name, 'handled_by_name', r.handled_by_name) as x
      from public.service_requests r
      join public.school_services s on s.id = r.service_id
      cross join lateral (select private.turn_details_ok(r.service_id, r.created_by) as ok) k
      left join public.service_request_details d on d.request_id = r.id
      where r.school_id = me.school_id
        and (p_from is null or (r.created_at at time zone v_tz)::date >= p_from)
        and (p_to is null or (r.created_at at time zone v_tz)::date <= p_to)
        and (p_service is null or r.service_id = p_service)
        and (v_group is null or r.group_name = v_group)
        and (v_name is null or r.student_name ilike '%' || v_name || '%' or r.created_by_name ilike '%' || v_name || '%'
             or (k.ok and d.reason ilike '%' || v_name || '%'))
      order by r.created_at desc
      limit 500
    ) t(x)
  ), '[]'::jsonb);
end;
$$;

-- Same as in 20261122000056, with the reason only for whoever sees the turn's details and each person's id.
create or replace function public.live_board(p_since timestamptz, p_today date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_since timestamptz := greatest(coalesce(p_since, now() - interval '12 hours'), now() - interval '36 hours');
  v_today date := case when p_today between current_date - 1 and current_date + 1 then p_today else current_date end;
begin
  if not private.can(me, 'live') then raise exception 'No tienes permiso para ver el tablero en vivo.'; end if;
  return jsonb_build_object(
    'services', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', s.id, 'name', s.name, 'mode', s.mode,
          'staff', (
            select coalesce(jsonb_agg(jsonb_build_object(
                'id', p.id, 'name', p.full_name, 'status', private.staff_status(st),
                'until', case when private.staff_status(st) <> 'available' then st.until end,
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
            where p.school_id = s.school_id and p.active and private.roles_of(p) && s.roles),
          'active', (
            select coalesce(jsonb_agg(jsonb_build_object(
                'id', r.id, 'student', r.student_name, 'group', r.group_name, 'status', r.status,
                'room', r.room, 'created_by_name', r.created_by_name,
                'reason', case when private.turn_details_ok(r.service_id, r.created_by)
                  then (select d.reason from public.service_request_details d where d.request_id = r.id) end,
                'level', case when r.status = 'waiting' then private.turn_level(r.severity, r.created_at) else r.severity end,
                'since', coalesce(r.returning_at, r.arrived_at, r.on_the_way_at, r.sent_at, r.called_at, r.created_at),
                'late', r.late_at is not null and r.arrived_at is null,
                'out_since', case when r.status in ('sent', 'arrived', 'returning')
                  then coalesce(r.sent_at, r.arrived_at, r.returning_at) end,
                'handled_by_name', r.handled_by_name)
              order by r.created_at), '[]'::jsonb)
            from public.service_requests r
            where r.service_id = s.id and r.status in ('waiting', 'called', 'sent', 'arrived', 'on_the_way', 'returning')),
          'today', (
            select jsonb_build_object(
              'requested', count(*),
              'done', count(*) filter (where r.status = 'done'),
              'returned', count(*) filter (where r.outcome = 'returned'),
              'picked_up', count(*) filter (where r.outcome = 'picked_up'),
              'referred', count(*) filter (where r.outcome = 'referred'),
              'late', count(*) filter (where r.late_at is not null),
              'cancelled', count(*) filter (where r.outcome = 'cancelled'),
              'expired', count(*) filter (where r.outcome = 'expired'))
            from public.service_requests r
            where r.service_id = s.id and r.created_at >= v_since))
        order by s.position, s.name)
      from public.school_services s
      where s.school_id = me.school_id and s.active
    ), '[]'::jsonb),
    'alerts', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', a.id, 'student', st.name, 'group', a.group_name, 'place', a.place, 'audience', a.audience,
          'created_at', a.created_at, 'created_by_name', a.created_by_name)
        order by a.created_at)
      from public.student_alerts a
      left join public.students st on st.id = a.student_id
      where a.school_id = me.school_id and a.resolved_at is null and a.created_at > now() - interval '24 hours'
    ), '[]'::jsonb),
    'pickups', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', k.id, 'student', st.name, 'group', k.group_name, 'status', k.status, 'expected_time', k.expected_time)
        order by k.expected_time nulls last, k.created_at)
      from public.student_pickups k
      left join public.students st on st.id = k.student_id
      where k.school_id = me.school_id and k.status in ('scheduled', 'arrived', 'on_the_way') and k.created_at >= v_since
    ), '[]'::jsonb),
    'pickups_done', (
      select count(*) from public.student_pickups k
      where k.school_id = me.school_id and k.status = 'delivered' and k.created_at >= v_since),
    'relief', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.requested_by_name, 'room', x.room, 'created_at', x.created_at)
        order by x.created_at)
      from public.relief_requests x
      where x.school_id = me.school_id and x.taken_at is null and x.cancelled_at is null
        and x.created_at > now() - interval '30 minutes'
    ), '[]'::jsonb),
    'maintenance', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', m.id, 'kind', m.kind, 'place', m.place, 'urgency', m.urgency, 'status', m.status,
          'taken_by_name', m.taken_by_name, 'created_at', m.created_at)
        order by m.urgency desc, m.created_at)
      from public.maintenance_requests m
      where m.school_id = me.school_id and m.status in ('pending', 'on_the_way')
    ), '[]'::jsonb),
    'maintenance_done', (
      select count(*) from public.maintenance_requests m
      where m.school_id = me.school_id and m.status = 'done' and m.done_at >= v_since),
    'rooms', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', b.id, 'start_time', b.start_time, 'end_time', b.end_time, 'purpose', b.purpose,
          'created_by_name', b.created_by_name)
        order by b.start_time)
      from public.room_bookings b
      where b.school_id = me.school_id and b.day = v_today and b.status = 'approved'
    ), '[]'::jsonb),
    'rooms_pending', (
      select count(*) from public.room_bookings b
      where b.school_id = me.school_id and b.status = 'pending' and b.day >= v_today)
  );
end;
$$;

-- Same as in 20261209000073: a sealed document of turns carries the reason and the result only for whoever sees them.
create or replace function public.seal_document(
  p_kind text, p_format text, p_title text, p_details text default null,
  p_ids bigint[] default null, p_user uuid default null, p_from timestamptz default null, p_to timestamptz default null,
  p_items integer default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_full boolean := private.history_full(me);
  v_content jsonb;
  v_items integer;
  v_hash text;
  v_code text;
  v_at timestamptz := now();
begin
  if p_format not in ('pdf', 'image', 'excel') then raise exception 'Formato no válido.'; end if;
  if coalesce(btrim(p_title), '') = '' then raise exception 'Falta el título del documento.'; end if;
  if (select count(*) from public.document_seals d where d.created_by = me.id and d.created_at > now() - interval '1 hour') >= 200 then
    raise exception 'Se crearon muchos documentos en la última hora. Espera un poco.';
  end if;

  if p_kind = 'absences' then
    if coalesce(cardinality(p_ids), 0) = 0 or cardinality(p_ids) > 500 then raise exception 'Elige de 1 a 500 ausencias.'; end if;
    if not (private.can(me, 'absence_search') or private.can(me, 'absences')) and (
      not private.can(me, 'own_absence_search')
      or exists (select 1 from public.absences a where a.id = any(p_ids) and a.user_id <> me.id)
    ) then
      raise exception 'No tienes permiso para guardar estas ausencias.';
    end if;
    select jsonb_agg(jsonb_build_object(
        'id', a.id, 'employee_name', p.full_name, 'employee_position', p.position, 'groups', to_jsonb(p.groups),
        'start_date', a.start_date, 'end_date', a.end_date, 'partial', a.partial,
        'start_time', to_char(a.start_time, 'HH24:MI'), 'end_time', to_char(a.end_time, 'HH24:MI'),
        'status', a.status, 'category', a.category, 'reason', a.reason, 'no_cover', a.no_cover,
        'covers', (select coalesce(jsonb_agg(c ->> 'name'), '[]'::jsonb) from jsonb_array_elements(coalesce(a.covers, '[]'::jsonb)) c))
        order by a.start_date desc, p.full_name)
      into v_content
    from public.absences a join public.profiles p on p.id = a.user_id
    where a.id = any(p_ids) and a.school_id = me.school_id;
    v_items := coalesce(jsonb_array_length(v_content), 0);

  elsif p_kind = 'turns' then
    if coalesce(cardinality(p_ids), 0) = 0 or cardinality(p_ids) > 500 then raise exception 'Elige de 1 a 500 turnos.'; end if;
    if not (private.can(me, 'turn_search') or v_full) then raise exception 'No tienes permiso para guardar estos turnos.'; end if;
    select jsonb_agg(jsonb_build_object(
        'id', r.id, 'service_name', s.name, 'service_mode', s.mode, 'student_name', r.student_name, 'group_name', r.group_name,
        'room', r.room, 'severity', r.severity, 'reason', case when k.ok then d.reason end, 'status', r.status,
        'outcome', private.turn_outcome_shown(r.outcome, k.ok),
        'created_at', r.created_at, 'closed_at', r.closed_at, 'created_by_name', r.created_by_name,
        'handled_by_name', r.handled_by_name, 'closed_by_name', r.closed_by_name)
        order by r.created_at desc)
      into v_content
    from public.service_requests r
    join public.school_services s on s.id = r.service_id
    cross join lateral (select private.turn_details_ok(r.service_id, r.created_by) as ok) k
    left join public.service_request_details d on d.request_id = r.id
    where r.id = any(p_ids) and r.school_id = me.school_id;
    v_items := coalesce(jsonb_array_length(v_content), 0);

  elsif p_kind = 'history' then
    if not private.can(me, 'history') then raise exception 'No tienes permiso para ver el historial.'; end if;
    if not exists (select 1 from public.profiles p where p.id = p_user and p.school_id = me.school_id) then
      raise exception 'Empleado no encontrado.';
    end if;
    select jsonb_agg(jsonb_build_object('at', x.at, 'actor_name', x.actor_name, 'action', x.action, 'details', x.details,
        'record', case when v_full then x.record end) order by x.at)
      into v_content
    from (
      select l.at, l.actor_name, l.action, l.details, l.record from public.activity_log l
      where l.school_id = me.school_id and (l.actor_id = p_user or l.subject_id = p_user)
        and l.at >= coalesce(p_from, now() - interval '400 days') and l.at < coalesce(p_to, now() + interval '1 day')
      order by l.at desc limit 2000
    ) x;
    v_items := coalesce(jsonb_array_length(v_content), 0);

  elsif p_kind = 'school_history' then
    if not private.can(me, 'history') then raise exception 'No tienes permiso para ver el historial.'; end if;
    select count(*), encode(sha256(convert_to(coalesce(string_agg(
        concat_ws('|', l.id, l.at, l.actor_name, l.action, l.details, case when v_full then l.record end), E'\n' order by l.at, l.id), ''), 'UTF8')), 'hex')
      into v_items, v_hash
    from public.activity_log l
    where l.school_id = me.school_id and l.at >= p_from and l.at < p_to;
    v_content := jsonb_build_object('from', p_from, 'to', p_to);

  elsif p_kind = 'export' then
    v_items := greatest(coalesce(p_items, 0), 0);
    v_content := null;

  else
    raise exception 'Tipo de documento no válido.';
  end if;

  v_hash := coalesce(v_hash, encode(sha256(convert_to(coalesce(v_content::text, '') || '|' || v_items, 'UTF8')), 'hex'));
  loop
    v_code := private.seal_code();
    exit when not exists (select 1 from public.document_seals d where d.code = v_code);
  end loop;
  insert into public.document_seals (code, school_id, kind, format, title, details, items, content, content_hash,
    created_by, created_by_name, created_at)
  values (v_code, me.school_id, p_kind, p_format, left(btrim(p_title), 200), left(nullif(btrim(p_details), ''), 500),
    v_items, v_content, v_hash, me.id, me.full_name, v_at);
  return jsonb_build_object('code', v_code, 'created_at', v_at, 'items', v_items, 'hash', left(v_hash, 12),
    'created_by_name', me.full_name);
end;
$$;

