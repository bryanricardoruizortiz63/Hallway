-- Resumen del día: each service's turns of that day, one by one, and each turn opens with everything about it (the
-- same as En vivo). For whoever sees the summary, En vivo or attends the service.

/** The turns a service got between p_from and p_to (the phone's day, at most 30 hours, within the last 61 days). */
create or replace function public.day_turns(p_service_id bigint, p_from timestamptz, p_to timestamptz)
returns table (
  id bigint, student_name text, group_name text, room text, severity smallint, level int, status text, outcome text,
  reason text, resolution text, created_by_name text, teacher_name text, handled_by_name text, closed_by_name text,
  out_of_order boolean, created_at timestamptz, called_at timestamptz, sent_at timestamptz, arrived_at timestamptz,
  on_the_way_at timestamptz, returning_at timestamptz, closed_at timestamptz, late_at timestamptz,
  return_late_at timestamptz
)
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
      r.status, r.outcome, d.reason, d.resolution, r.created_by_name, r.teacher_name, r.handled_by_name,
      r.closed_by_name, r.out_of_order, r.created_at, r.called_at, r.sent_at, r.arrived_at, r.on_the_way_at,
      r.returning_at, r.closed_at, r.late_at, r.return_late_at
    from public.service_requests r
    left join public.service_request_details d on d.request_id = r.id
    where r.service_id = p_service_id and r.created_at >= p_from and r.created_at < p_to
    order by r.created_at;
end;
$$;

revoke execute on function public.day_turns(bigint, timestamptz, timestamptz) from public, anon;
grant execute on function public.day_turns(bigint, timestamptz, timestamptz) to authenticated;

-- Same as in 20261102000036, also for whoever sees the Resumen del día.
create or replace function public.live_turn(p_id bigint)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  r public.service_requests;
  v jsonb;
begin
  select * into r from public.service_requests x where x.id = p_id and x.school_id = me.school_id;
  if r.id is null then
    raise exception 'No se encontró el turno.';
  end if;
  if not (private.can(me, 'live') or private.can(me, 'summary') or private.serves(r.service_id)) then
    raise exception 'No tienes permiso para ver este turno.';
  end if;
  select jsonb_build_object(
    'id', r.id, 'service_id', r.service_id, 'service_name', s.name, 'service_mode', s.mode,
    'student_name', r.student_name, 'group_name', r.group_name, 'room', r.room,
    'severity', r.severity,
    'level', case when r.status = 'waiting' then private.turn_level(r.severity, r.created_at) else r.severity::int end,
    'position', case when r.status = 'waiting' then private.turn_position(r.id) end,
    'status', r.status, 'outcome', r.outcome, 'reason', d.reason, 'note', d.note, 'resolution', d.resolution,
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
