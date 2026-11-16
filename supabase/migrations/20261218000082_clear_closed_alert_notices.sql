-- At the end of the school day the bell also lets go of the pickups, relief requests and visits that were already
-- closed during the day (a pickup cancelled or handed over, a relief taken, a visit attended). Until now only the
-- ones still open were cleared (20261217000081), so a «Salida cancelada» from the morning stayed there the next day.
-- They stay in the history. The «¿Se entregó?» question to Seguridad stays until it's answered.

/** Every 5 minutes (pg_cron): what is still open from a school day that already ended. Same as in 20261217000081, plus
 * the notices of what was already closed that day. */
create or replace function private.close_school_day()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  s record;
  v_local timestamp;
  v_cutoff timestamptz;
  v_today_start timestamptz;
  v_id bigint;
  k record;
  v_security uuid[];
begin
  for s in
    select x.id, coalesce(st.time_zone, 'America/Puerto_Rico') as tz, coalesce(st.day_end, '15:30'::time) as day_end,
      coalesce(st.day_start, '07:40'::time) as day_start, coalesce(st.school_days, '{1,2,3,4,5}'::smallint[]) as school_days
    from public.schools x
    left join public.school_settings st on st.school_id = x.id
  loop
    v_local := now() at time zone s.tz;
    v_today_start := v_local::date::timestamp at time zone s.tz;
    -- After today's end: everything from today and before; earlier in the day: only what is from previous days.
    v_cutoff := case
      when v_local >= v_local::date + s.day_end then (v_local::date + s.day_end) at time zone s.tz
      else v_today_start
    end;

    for v_id in
      update public.service_requests x
      set status = case when x.status = 'returning' then 'done' else 'cancelled' end,
        outcome = case when x.status = 'returning' then 'unconfirmed' else 'expired' end,
        closed_at = now(), closed_by_name = 'Hallway', remind_at = null
      where x.school_id = s.id and x.status not in ('done', 'cancelled') and x.created_at < v_cutoff
        -- Services set to keep their turns open (Soporte IT, Trabajo Social…) carry them to the next day.
        and not exists (select 1 from public.school_services svc where svc.id = x.service_id and svc.keep_open)
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

    -- Pickups nobody marked as handed over (or cancelled): «Sin confirmar». The student's name stays until Seguridad
    -- answers the next day (at most 4 days).
    for k in
      update public.student_pickups p
      set status = 'cancelled', cancelled_at = now(), cancelled_by_name = 'Hallway', unconfirmed = true
      where p.school_id = s.id and p.status not in ('delivered', 'cancelled') and p.created_at < v_cutoff
      returning p.id, p.student_id
    loop
      delete from public.notifications where link = '#/alerts/pickup/' || k.id;
      update public.students set expires_at = greatest(expires_at, now() + interval '4 days') where id = k.student_id;
    end loop;

    -- Relief requests nobody took.
    for v_id in
      update public.relief_requests r
      set cancelled_at = now(), unconfirmed = true
      where r.school_id = s.id and r.taken_at is null and r.cancelled_at is null and r.created_at < v_cutoff
      returning r.id
    loop
      delete from public.notifications where link = '#/alerts/relief/' || v_id;
    end loop;

    -- Visits: one that someone answered is taken as attended; one nobody answered, «Sin confirmar».
    for v_id in
      update public.visits v
      set status = case when v.status = 'answered' then 'done' else 'cancelled' end,
        unconfirmed = v.status = 'waiting', closed_at = now(), closed_by_name = 'Hallway'
      where v.school_id = s.id and v.status in ('waiting', 'answered') and v.created_at < v_cutoff
      returning v.id
    loop
      delete from public.notifications where link = '#/alerts/visit/' || v_id;
    end loop;

    -- What was already closed during the day (a pickup handed over or cancelled, a relief taken, a visit attended)
    -- also leaves the bell once the day is over: it stays in the history. Only «¿Se entregó?» waits for its answer.
    delete from public.notifications n
    using public.profiles pr
    where pr.id = n.user_id and pr.school_id = s.id and n.created_at < v_cutoff
      and (
        (n.link like '#/alerts/pickup/%' and not exists (
          select 1 from public.student_pickups p
          where n.link = '#/alerts/pickup/' || p.id and p.unconfirmed and p.followup is null))
        or n.link like '#/alerts/relief/%'
        or n.link like '#/alerts/visit/%'
      );

    -- The next school day, once the day starts: «¿Se entregó?» to Seguridad, for each pickup left unconfirmed.
    if v_local >= v_local::date + s.day_start
      and extract(isodow from v_local)::smallint = any(s.school_days)
      and not exists (select 1 from public.school_closures c where c.school_id = s.id and v_local::date between c.start_date and c.end_date)
    then
      for k in
        select p.id, p.group_name, st.name as student_name
        from public.student_pickups p
        left join public.students st on st.id = p.student_id
        where p.school_id = s.id and p.unconfirmed and p.followup is null and p.followup_asked_at is null
          and p.created_at < v_today_start and p.created_at > now() - interval '10 days'
      loop
        v_security := coalesce(v_security, private.perm_ids(s.id, 'security', null));
        perform private.notify(
          v_security,
          format('¿Se entregó? %s (%s)', coalesce(k.student_name, 'Estudiante'), k.group_name),
          'Su salida no se confirmó en la app antes de terminar el día. Toca para decir si se entregó o no.',
          '#/alerts/pickup/' || k.id
        );
        update public.student_pickups set followup_asked_at = now() where id = k.id;
      end loop;
      v_security := null;
    end if;
  end loop;
end;
$$;
revoke execute on function private.close_school_day() from public, anon, authenticated;
