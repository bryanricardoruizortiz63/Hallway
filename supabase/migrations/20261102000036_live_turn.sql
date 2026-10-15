-- En vivo › un turno: al tocar la tarjeta de un estudiante (en fila, en camino, en atención o ya atendido), todo lo
-- de ese turno en una pantalla.
--   * live_turn(id): para quien tiene «En vivo» (la dirección, la secretaría, Administración) o atiende ese servicio.
--     El estudiante y su grupo (o quién pidió ayuda y dónde, en Soporte IT), el motivo, la nota del maestro, qué tan
--     grave es (y si subió por la espera), su lugar en la fila, quién lo pidió, quién lo tiene, quién lo atiende,
--     cada paso con su hora, el tiempo para llegar, si tardó, cómo terminó y qué se hizo.

/** One turn of the school, with everything about it (also the teacher's note). */
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
  if not (private.can(me, 'live') or private.serves(r.service_id)) then
    raise exception 'No tienes permiso para ver el tablero en vivo.';
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

revoke execute on function public.live_turn(bigint) from public, anon;
grant execute on function public.live_turn(bigint) to authenticated;
