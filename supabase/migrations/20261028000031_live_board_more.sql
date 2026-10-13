-- En vivo, more:
--   * live_board: each turn of a student says since when they are out of the room (out_since: when they left,
--     or arrived, for whoever is on the way to the service, in it or going back), for «Fuera del salón ahora».
--   * live_hours(service, since): how many turns the service had at each hour of the day over the last 4 weeks
--     (before today), in the school's time zone, and on how many days: for «Horas pico». Only counts, no names.
--     Whoever has «En vivo» or attends that service.

/**
 * p_since: when "today" started on the phone (the server doesn't know the school's time zone);
 * p_today: the phone's date, for the room reservations.
 * Each service's staff and its turns (student and group, or who asked and where for support; the reason, never
 * the note), open "No ha llegado" alerts, today's pickups and relief requests, open maintenance requests and
 * today's conference room reservations.
 */
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
                'name', p.full_name, 'status', private.staff_status(st),
                'until', case when private.staff_status(st) <> 'available' then st.until end)
              order by p.full_name), '[]'::jsonb)
            from public.profiles p
            left join public.service_staff_status st on st.user_id = p.id
            where p.school_id = s.school_id and p.active and p.role = any(s.roles)),
          'active', (
            select coalesce(jsonb_agg(jsonb_build_object(
                'id', r.id, 'student', r.student_name, 'group', r.group_name, 'status', r.status,
                'room', r.room, 'created_by_name', r.created_by_name,
                'reason', (select d.reason from public.service_request_details d where d.request_id = r.id),
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
              'late', count(*) filter (where r.late_at is not null))
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

/** The service's turns by hour of the day over the 4 weeks before p_since (when today started on the phone). */
create or replace function public.live_hours(p_service_id bigint, p_since timestamptz)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_until timestamptz := greatest(least(coalesce(p_since, now()), now()), now() - interval '36 hours');
  v_tz text;
begin
  if not exists (select 1 from public.school_services s where s.id = p_service_id and s.school_id = me.school_id) then
    raise exception 'No se encontró el servicio.';
  end if;
  if not (private.can(me, 'live') or private.serves(p_service_id)) then
    raise exception 'No tienes permiso para ver el tablero en vivo.';
  end if;
  select coalesce((select s.time_zone from public.school_settings s where s.school_id = me.school_id), 'America/Puerto_Rico')
  into v_tz;
  return (
    with t as (
      select r.created_at at time zone v_tz as local
      from public.service_requests r
      where r.service_id = p_service_id and r.created_at >= v_until - interval '28 days' and r.created_at < v_until
    )
    select jsonb_build_object(
      'days', (select count(distinct t.local::date) from t),
      'hours', coalesce((
        select jsonb_agg(jsonb_build_object('hour', x.hour, 'turns', x.turns) order by x.hour)
        from (select extract(hour from t.local)::int as hour, count(*)::int as turns from t group by 1) x
      ), '[]'::jsonb))
  );
end;
$$;

revoke execute on function public.live_hours(bigint, timestamptz) from public, anon;
grant execute on function public.live_hours(bigint, timestamptz) to authenticated;
