-- When the school day ends, what is still open of the day also closes for the pickups (salidas), the relief requests
-- (relevos) and the visits, as it already did for the turns and the «No ha llegado» alerts. Until now a pickup that
-- nobody marked kept showing (and ringing) the next day.
--   * They stay in the history, marked «Sin confirmar»: nobody confirmed them in the app before the day ended.
--   * Their notices are removed from the bell.
--   * A pickup nobody confirmed: the next school day, when the day starts, Seguridad is asked «¿Se entregó?». The
--     answer (it was handed over, or it wasn't) stays recorded. The student's name is kept until then (normally 24
--     hours), at most 4 days, so Seguridad knows who it was.

alter table public.student_pickups
  add column if not exists unconfirmed boolean not null default false,
  add column if not exists followup text check (followup in ('delivered', 'not_delivered')),
  add column if not exists followup_note text check (char_length(followup_note) <= 300),
  add column if not exists followup_by_name text,
  add column if not exists followup_at timestamptz,
  add column if not exists followup_asked_at timestamptz;
alter table public.relief_requests add column if not exists unconfirmed boolean not null default false;
alter table public.visits add column if not exists unconfirmed boolean not null default false;

-- Same as in 20261009000012, with the new columns (k.* is fixed when the view is made, so it is made again).
drop view if exists public.student_pickups_v;
create view public.student_pickups_v with (security_invoker = true) as
  select k.*, s.name as student_name from public.student_pickups k left join public.students s on s.id = k.student_id;

/** Every 5 minutes (pg_cron): what is still open from a school day that already ended. Same as in 20261125000059, plus
 * the pickups, the relief requests and the visits, and the next day's question to Seguridad. */
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

/** Seguridad answers «¿Se entregó?» for a pickup left unconfirmed: it stays recorded with who and when. */
create or replace function public.answer_pickup_followup(p_id bigint, p_delivered boolean, p_note text default null)
returns public.student_pickups
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  k public.student_pickups;
begin
  if not private.can(me, 'security') then raise exception 'Solo Seguridad puede responder esto.'; end if;
  select * into k from public.student_pickups where id = p_id and school_id = me.school_id for update;
  if k.id is null then raise exception 'No se encontró la salida.'; end if;
  if not k.unconfirmed then raise exception 'Esta salida no quedó sin confirmar.'; end if;
  if k.followup is not null then raise exception 'Ya se respondió: %.', case k.followup when 'delivered' then 'se entregó' else 'no se entregó' end; end if;
  update public.student_pickups
  set followup = case when p_delivered then 'delivered' else 'not_delivered' end,
    followup_note = private.clean_text(p_note, 300, 'La nota'),
    followup_by_name = me.full_name, followup_at = now()
  where id = p_id
  returning * into k;
  perform private.close_notifications('#/alerts/pickup/' || p_id);
  perform private.log_activity(me.school_id, me.id,
    case when p_delivered then 'Confirmó que se entregó a un estudiante de ' else 'Confirmó que no se entregó a un estudiante de ' end
      || k.group_name || ' (salida sin confirmar)',
    k.followup_note, '#/alerts/pickup/' || k.id, null);
  return k;
end;
$$;
revoke execute on function public.answer_pickup_followup(bigint, boolean, text) from public, anon;
grant execute on function public.answer_pickup_followup(bigint, boolean, text) to authenticated;
