-- Al terminar el día escolar (school_settings.day_end, en la zona horaria de la escuela) se cierra lo que sigue
-- abierto de ese día: los turnos (un regreso sin confirmar queda «Regreso sin confirmar»; lo demás, «Nadie lo
-- cerró») y las alertas de «No ha llegado» que nadie confirmó, que quedan como «Sin confirmar» (unconfirmed).
-- Así al otro día no aparece nadie como que no ha llegado. Queda el reporte: el turno con su resultado, la alerta
-- cerrada y el resumen del día ("N sin confirmar"). Lo de días anteriores se cierra en cuanto corre.
-- Soporte IT no se toca: esos pedidos esperan al servicio. El cierre a las 14 horas de check_turn_timers se queda
-- como respaldo.

alter table public.student_alerts add column unconfirmed boolean not null default false;

create or replace view public.student_alerts_v with (security_invoker = true) as
select a.id, a.school_id, a.student_id, a.group_name, a.place, a.room, a.note, a.audience, a.created_by,
  a.created_by_name, a.created_at, a.resolved_at, a.resolved_by, a.resolved_by_name, a.found_place,
  s.name as student_name, a.turn_id, a.unconfirmed
from public.student_alerts a
left join public.students s on s.id = a.student_id;

/** Every 5 minutes (pg_cron): what is still open from a school day that already ended. */
create or replace function private.close_school_day()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  s record;
  v_local timestamp;
  v_cutoff timestamptz;
  v_id bigint;
begin
  for s in
    select x.id, coalesce(st.time_zone, 'America/Puerto_Rico') as tz, coalesce(st.day_end, '15:30'::time) as day_end
    from public.schools x
    left join public.school_settings st on st.school_id = x.id
  loop
    v_local := now() at time zone s.tz;
    -- After today's end: everything from today and before; earlier in the day: only what is from previous days.
    v_cutoff := case
      when v_local >= v_local::date + s.day_end then (v_local::date + s.day_end) at time zone s.tz
      else v_local::date::timestamp at time zone s.tz
    end;

    for v_id in
      update public.service_requests x
      set status = case when x.status = 'returning' then 'done' else 'cancelled' end,
        outcome = case when x.status = 'returning' then 'unconfirmed' else 'expired' end,
        closed_at = now(), closed_by_name = 'Hallway', remind_at = null
      where x.school_id = s.id and x.status not in ('done', 'cancelled') and x.created_at < v_cutoff
        and not exists (select 1 from public.school_services svc where svc.id = x.service_id and svc.mode = 'support')
      returning x.id
    loop
      perform private.close_notifications('#/turns/' || v_id);
    end loop;

    for v_id in
      update public.student_alerts a
      set resolved_at = now(), resolved_by_name = 'Hallway', unconfirmed = true
      where a.school_id = s.id and a.resolved_at is null and a.created_at < v_cutoff
      returning a.id
    loop
      perform private.close_notifications('#/alerts/missing/' || v_id);
    end loop;
  end loop;
end;
$$;

revoke execute on function private.close_school_day() from public, anon, authenticated;

-- The day's summary counts them as not confirmed (same as before, when they stayed open).
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
      select jsonb_build_object('missing', count(*), 'unresolved', count(*) filter (where a.resolved_at is null or a.unconfirmed))
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

select cron.schedule('hallway-close-school-day', '*/5 * * * *', $job$select private.close_school_day()$job$);
