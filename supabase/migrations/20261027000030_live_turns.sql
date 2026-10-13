-- En vivo: a service's turns of the day, with everything that happened to each one.
--   * live_turns(service, since): for whoever has «En vivo» (or attends that service). The day's turns (since
--     p_since: when the day started on the phone) and any still open from before (Soporte IT waits for the service):
--     the student and group (or who asked and where, for support), the reason, how serious, who asked, who has the
--     student, who attended, every step with its time, how it ended and what was done. Never the teacher's note.

create or replace function public.live_turns(p_service_id bigint, p_since timestamptz)
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
      r.status, r.outcome, d.reason, d.resolution, r.created_by_name, r.teacher_name, r.handled_by_name,
      r.closed_by_name, r.out_of_order, r.created_at, r.called_at, r.sent_at, r.arrived_at, r.on_the_way_at,
      r.returning_at, r.closed_at, r.late_at, r.return_late_at
    from public.service_requests r
    left join public.service_request_details d on d.request_id = r.id
    where r.service_id = p_service_id
      and (r.created_at >= v_since or r.status not in ('done', 'cancelled'))
    order by r.created_at
    limit 500;
end;
$$;

revoke execute on function public.live_turns(bigint, timestamptz) from public, anon;
grant execute on function public.live_turns(bigint, timestamptz) to authenticated;
