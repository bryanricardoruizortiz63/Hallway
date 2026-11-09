-- The other fixed times of the turns, also chosen by each school in Escuela y Teams › Avisos urgentes:
--   * call_reminder: a called student nobody has sent yet — the teachers are reminded every N minutes (1–10), M times
--     (1–10), then the service is told. It was every 3 minutes, 4 times.
--   * return_answer: «¿Ya llegó al salón?» — minutes the teachers have to answer before Seguridad is told (1–15).
--     It was 3.
-- Stored with the repeats in school_settings.urgent_repeat.

/** One of the school's turn timings, or its default. */
create or replace function private.turn_timing(p_school uuid, p_key text, p_field text, p_default int)
returns int
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select (st.urgent_repeat -> p_key ->> p_field)::int from public.school_settings st where st.school_id = p_school
  ), p_default)
$$;

-- Same as in 20261213000077, also with call_reminder and return_answer.
create or replace function public.set_urgent_repeat(p_settings jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v jsonb := '{}'::jsonb;
  k text;
  e int;
  f int;
begin
  if not private.can(me, 'settings') then raise exception 'No tienes permiso para cambiar la configuración de la escuela.'; end if;
  for k in select jsonb_object_keys(coalesce(p_settings, '{}'::jsonb)) loop
    if k = 'call_reminder' then
      e := (p_settings -> k ->> 'every')::int;
      f := (p_settings -> k ->> 'times')::int;
      if e is null or e not between 1 and 10 then raise exception 'Cada cuánto se recuerda no es válido.'; end if;
      if f is null or f not between 1 and 10 then raise exception 'Cuántas veces se recuerda no es válido.'; end if;
      v := v || jsonb_build_object(k, jsonb_build_object('every', e, 'times', f));
    elsif k = 'return_answer' then
      e := (p_settings -> k ->> 'minutes')::int;
      if e is null or e not between 1 and 15 then raise exception 'El tiempo para responder no es válido.'; end if;
      v := v || jsonb_build_object(k, jsonb_build_object('minutes', e));
    elsif k in ('turns', 'alerts', 'pickups', 'relief', 'visits', 'maintenance') then
      e := (p_settings -> k ->> 'every')::int;
      f := (p_settings -> k ->> 'for')::int;
      if e is null or e not in (0, 1, 2, 3, 5, 10, 15) then raise exception 'Cada cuánto se repite no es válido.'; end if;
      if f is null or f not in (5, 10, 15, 20, 30, 45, 60) then raise exception 'Por cuánto tiempo no es válido.'; end if;
      v := v || jsonb_build_object(k, jsonb_build_object('every', e, 'for', f));
    else
      raise exception 'Tipo de aviso no válido.';
    end if;
  end loop;
  update public.school_settings set urgent_repeat = v where school_id = me.school_id;
  return v;
end;
$$;

/** Whenever a called turn gets its next reminder time, it uses the school's interval (it was always 3 minutes). */
create or replace function private.turn_remind_interval()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.status = 'called' and new.remind_at is not null
     and (tg_op = 'INSERT' or new.remind_at is distinct from old.remind_at) then
    new.remind_at := now() + make_interval(mins => private.turn_timing(new.school_id, 'call_reminder', 'every', 3));
  end if;
  return new;
end;
$$;
drop trigger if exists service_requests_remind_interval on public.service_requests;
create trigger service_requests_remind_interval before insert or update of remind_at on public.service_requests
  for each row execute function private.turn_remind_interval();

-- Same as before (20261124000058), with the school's number of reminders and the minutes to answer «¿Ya llegó?».
create or replace function private.check_turn_timers()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  r public.service_requests;
  s public.school_services;
  a public.student_alerts;
  v_who text;
  v_mins int;
  v_near uuid[];
  v_since text;
  v_answer int;
begin
  -- Called, and nobody has sent the student yet.
  for r in
    select * from public.service_requests x
    where x.status = 'called' and x.remind_at < now()
    for update skip locked
  loop
    select * into s from public.school_services x where x.id = r.service_id;
    v_who := format('%s (%s)', r.student_name, r.group_name);
    v_mins := greatest(1, round(extract(epoch from now() - r.called_at) / 60)::int);
    if r.reminders < private.turn_timing(r.school_id, 'call_reminder', 'times', 4) then
      -- The next time comes from the school's interval (turn_remind_interval).
      update public.service_requests set reminders = reminders + 1, remind_at = now() + interval '3 minutes' where id = r.id;
      -- The previous notice is replaced by the new one.
      perform private.close_notifications('#/turns/' || r.id);
      perform private.notify_tagged(private.call_teacher_ids(r, null),
        format('⏰ %s espera a %s', s.name, v_who),
        format('Lo llamaron hace %s min. Si está contigo, envíalo y toca «Ya salió».', v_mins),
        '#/turns/' || r.id, 'turn-' || r.id, false);
    else
      update public.service_requests set remind_at = null where id = r.id;
      perform private.notify_tagged(private.service_staff_ids(s.id, null),
        format('⏰ Nadie ha enviado a %s', v_who),
        format('Lo llamaron hace %s min y ningún maestro tocó «Ya salió». Puedes esperar, tocar «Llegó» cuando llegue o cancelar el turno.', v_mins),
        '#/turns/' || r.id, 'turn-' || r.id, false);
    end if;
  end loop;

  -- On the way to the service.
  for r in
    select * from public.service_requests x
    where x.status = 'sent' and x.late_at is null and x.due_at < now()
    for update skip locked
  loop
    select * into s from public.school_services x where x.id = r.service_id;
    update public.service_requests set late_at = now() where id = r.id;
    v_who := format('%s (%s)', r.student_name, r.group_name);
    v_mins := greatest(1, round(extract(epoch from now() - r.sent_at) / 60)::int);
    v_since := concat_ws(' ', 'Salió', 'del salón ' || r.room, format('hace %s min', v_mins));
    v_near := array_append(private.service_staff_ids(s.id, null), r.teacher_id);
    a := null;
    if not exists (
      select 1 from public.student_alerts x
      where x.school_id = r.school_id and x.resolved_at is null
        and (x.turn_id = r.id or (r.student_id is not null and x.student_id = r.student_id))
    ) then
      insert into public.student_alerts (school_id, student_id, group_name, place, room, note, audience, created_by, created_by_name, turn_id)
      values (r.school_id, r.student_id, r.group_name, format('Iba a %s', s.name), r.room, null,
        'security', r.teacher_id, s.name, r.id)
      returning * into a;
      perform private.notify_tagged(private.uuid_minus(private.perm_ids(r.school_id, 'security', null), v_near),
        format('🚨 No ha llegado a %s: %s', s.name, v_who),
        v_since || '. Si lo ves, toca «Apareció».',
        '#/alerts/missing/' || a.id, 'missing-' || a.id, true);
    end if;
    perform private.notify_tagged(v_near,
      format('⏱️ No ha llegado a %s: %s', s.name, v_who),
      v_since || case when a.id is not null then '. Se avisó a Seguridad.' else '.' end,
      '#/turns/' || r.id, 'turn-' || r.id, true);
  end loop;

  -- On the way back to class, time's up: first the teachers are asked whether the student got there (they may be in
  -- another class, with a teacher who didn't know they were coming back)…
  for r in
    select * from public.service_requests x
    where x.status = 'returning' and x.return_check_at is null and x.return_late_at is null and x.due_at < now()
    for update skip locked
  loop
    select * into s from public.school_services x where x.id = r.service_id;
    update public.service_requests set return_check_at = now() where id = r.id;
    v_who := format('%s (%s)', r.student_name, r.group_name);
    v_mins := greatest(1, round(extract(epoch from now() - r.returning_at) / 60)::int);
    v_answer := private.turn_timing(r.school_id, 'return_answer', 'minutes', 3);
    perform private.close_notifications('#/turns/' || r.id);
    perform private.notify_tagged(
      array_cat(array[r.teacher_id], private.group_teacher_ids(r.school_id, r.group_name, array[r.teacher_id])),
      format('❓ ¿Ya llegó %s al salón?', v_who),
      format('Salió de %s hace %s min. Si está en tu clase, toca «Está en mi clase»; si no, «No ha llegado». Si nadie responde en %s %s, se avisa a Seguridad.',
        s.name, v_mins, v_answer, case when v_answer = 1 then 'minuto' else 'minutos' end),
      '#/turns/' || r.id, 'turn-' || r.id, true);
  end loop;

  -- …and if nobody answers in time, the service, the teachers and Seguridad are told.
  for r in
    select * from public.service_requests x
    where x.status = 'returning' and x.return_late_at is null
      and x.return_check_at < now() - make_interval(mins => private.turn_timing(x.school_id, 'return_answer', 'minutes', 3))
    for update skip locked
  loop
    perform private.return_overdue(r, null);
  end loop;

  -- The end of the day: a return nobody confirmed stays as such; the rest, closed without an outcome. Support
  -- requests wait for the service.
  update public.service_requests x
  set status = case when x.status = 'returning' then 'done' else 'cancelled' end,
    outcome = case when x.status = 'returning' then 'unconfirmed' else 'expired' end,
    closed_at = now(), closed_by_name = 'Sistema', remind_at = null
  where x.status not in ('done', 'cancelled') and x.created_at < now() - interval '14 hours'
    and not exists (select 1 from public.school_services svc where svc.id = x.service_id and svc.mode = 'support');
end;
$$;
