-- Turns kept open from earlier days, for whoever asked for them (a teacher): the next day the app asks them whether
-- they were attended, and they keep each turn or delete it (it is closed as cancelled; the history keeps it).
-- The service is told when a turn it still had open is deleted this way.

alter table public.service_requests add column if not exists requester_checked_at timestamptz;

/** The turns this person asked for that are still open from before today, not yet looked at today. */
create or replace function public.my_requested_carried_turns(p_since timestamptz)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_since timestamptz := greatest(coalesce(p_since, now() - interval '12 hours'), now() - interval '36 hours');
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'id', r.id, 'service_id', s.id, 'service_name', s.name,
        'service_mode', case when s.mode = 'either' then coalesce(r.flow, 'either') else s.mode end,
        'student_name', r.student_name, 'group_name', r.group_name, 'room', r.room, 'severity', r.severity,
        'status', r.status, 'reason', d.reason, 'note', d.note, 'created_at', r.created_at,
        'created_by_name', r.created_by_name, 'handled_by_name', r.handled_by_name)
      order by r.created_at)
    from public.service_requests r
    join public.school_services s on s.id = r.service_id
    left join public.service_request_details d on d.request_id = r.id
    where r.school_id = me.school_id and r.created_by = me.id
      and r.status not in ('done', 'cancelled') and r.created_at < v_since
      -- Whoever attends the service already decides about it in their own list.
      and not (private.roles_of(me) && s.roles)
      and (r.requester_checked_at is null or r.requester_checked_at < v_since)
  ), '[]'::jsonb);
end;
$$;
revoke execute on function public.my_requested_carried_turns(timestamptz) from public, anon;
grant execute on function public.my_requested_carried_turns(timestamptz) to authenticated;

/** What whoever asked decided: keep each turn (p_keep) or delete it (p_close). */
create or replace function public.review_requested_turns(p_keep bigint[], p_close bigint[])
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  r public.service_requests;
  v_service public.school_services;
  v_n int := 0;
begin
  if cardinality(coalesce(p_keep, '{}')) + cardinality(coalesce(p_close, '{}')) > 200 then
    raise exception 'Son demasiados turnos a la vez.';
  end if;
  for r in
    select x.* from public.service_requests x
    where x.school_id = me.school_id and x.created_by = me.id and x.status not in ('done', 'cancelled')
      and (x.id = any(coalesce(p_keep, '{}')) or x.id = any(coalesce(p_close, '{}')))
    for update
  loop
    select * into v_service from public.school_services s where s.id = r.service_id;
    if r.id = any(coalesce(p_close, '{}')) then
      update public.service_requests
      set status = 'cancelled', outcome = 'cancelled', closed_at = now(), closed_by_name = me.full_name, remind_at = null
      where id = r.id;
      update public.service_request_details
      set resolution = coalesce(resolution, 'Lo borró quien lo pidió al revisar sus turnos de días anteriores.')
      where request_id = r.id;
      perform private.close_notifications('#/turns/' || r.id);
      perform private.notify_tagged(private.service_staff_ids(v_service.id, me.id),
        format('📋 %s borró un turno del día anterior', me.full_name),
        format('%s · %s.', v_service.name, private.turn_label(r)),
        '#/turns/' || r.id, 'turn-' || r.id, false);
    else
      update public.service_requests set requester_checked_at = now() where id = r.id;
      perform private.log_activity(me.school_id, me.id,
        format('Mantuvo su turno del día anterior en %s para %s', v_service.name, private.turn_label(r)),
        'Del ' || to_char(r.created_at at time zone 'America/Puerto_Rico', 'DD/MM/YYYY HH12:MI AM'), '#/turns/' || r.id, null);
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
revoke execute on function public.review_requested_turns(bigint[], bigint[]) from public, anon;
grant execute on function public.review_requested_turns(bigint[], bigint[]) to authenticated;
