-- Regreso al salón sin falsas alarmas. Un estudiante que sale de Enfermería puede llegar a otra clase (cambió la hora)
-- cuyo maestro no sabía que venía, y nadie toca «Llegó al salón».
--   * Cuando se acaba el tiempo, primero se pregunta «¿Ya llegó?» al maestro que lo tenía y a los de su grupo, con
--     «Está en mi clase» y «No ha llegado» (return_check_at). Solo si nadie responde en 3 minutos, o alguien dice
--     que no llegó (paso missing), suena la alarma y Seguridad recibe «No ha llegado» (private.return_overdue).
--   * Cualquier maestro de la escuela puede marcar que llegó: en Turnos ve «Regresando a clase»
--     (returning_students: solo nombre y grupo, nunca el servicio ni el motivo).

alter table public.service_requests add column return_check_at timestamptz;

-- The app reads whether the teachers were already asked «¿Ya llegó?».
create or replace view public.service_requests_v with (security_invoker = true) as
  select r.id, r.school_id, r.service_id, r.student_id, r.student_name, r.student_key, r.group_name, r.room,
    r.severity, r.status, r.outcome, r.teacher_id, r.teacher_name, r.created_by, r.created_by_name, r.created_at,
    r.handled_by, r.handled_by_name, r.out_of_order, r.called_at, r.sent_at, r.due_at, r.late_at, r.arrived_at,
    r.on_the_way_at, r.returning_at, r.closed_at, r.closed_by_name,
    s.name as service_name, s.mode as service_mode, d.reason, d.note,
    case when r.status = 'waiting' then private.turn_level(r.severity, r.created_at) end as level,
    private.turn_position(r.id) as position,
    r.return_late_at,
    d.resolution,
    r.return_check_at
  from public.service_requests r
  join public.school_services s on s.id = r.service_id
  left join public.service_request_details d on d.request_id = r.id;

/**
 * A student on the way back to class who hasn't been confirmed there: the service, the teacher who had them and the
 * other teachers of the group get the alarm, and Seguridad the alert «No ha llegado» (unless one is already open).
 * p_by: who said they haven't arrived (null: nobody answered «¿Ya llegó?» in time).
 */
create or replace function private.return_overdue(r public.service_requests, p_by text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  s public.school_services;
  a public.student_alerts;
  v_who text := format('%s (%s)', r.student_name, r.group_name);
  v_mins int := greatest(1, round(extract(epoch from now() - r.returning_at) / 60)::int);
  v_near uuid[];
  v_since text;
begin
  select * into s from public.school_services x where x.id = r.service_id;
  update public.service_requests set return_late_at = now() where id = r.id;
  v_since := format('Salió de %s hace %s min', s.name, v_mins) || case when p_by is not null then format('; %s dice que no ha llegado', p_by) else '' end;
  v_near := array_cat(array_append(private.service_staff_ids(s.id, null), r.teacher_id),
    private.group_teacher_ids(r.school_id, r.group_name, array[r.teacher_id]));
  if not exists (
    select 1 from public.student_alerts x
    where x.school_id = r.school_id and x.resolved_at is null
      and (x.turn_id = r.id or (r.student_id is not null and x.student_id = r.student_id))
  ) then
    insert into public.student_alerts (school_id, student_id, group_name, place, room, note, audience, created_by, created_by_name, turn_id)
    values (r.school_id, r.student_id, r.group_name, format('Regresaba de %s', s.name), r.room,
      case when p_by is null then 'Nadie confirmó que llegó al salón.' else format('%s dice que no llegó al salón.', p_by) end,
      'security', r.teacher_id, s.name, r.id)
    returning * into a;
    perform private.notify_tagged(private.uuid_minus(private.perm_ids(r.school_id, 'security', null), v_near),
      format('🚨 No ha llegado al salón: %s', v_who),
      v_since || '. Si lo ves, toca «Apareció».',
      '#/alerts/missing/' || a.id, 'missing-' || a.id, true);
  end if;
  -- The question «¿Ya llegó?» gives way to the alarm.
  perform private.close_notifications('#/turns/' || r.id);
  perform private.notify_tagged(v_near,
    format('⏱️ No ha llegado al salón: %s', v_who),
    v_since || case when a.id is not null then '. Se avisó a Seguridad.' else '.' end || ' Si ya llegó, toca «Llegó al salón».',
    '#/turns/' || r.id, 'turn-' || r.id, true);
end;
$$;

revoke execute on function private.return_overdue(public.service_requests, text) from public, anon, authenticated;

/**
 * Every minute (pg_cron):
 *   * a called student nobody has sent yet: a reminder to whoever should send them, every 3 minutes, four times;
 *     then the service is told;
 *   * a student sent to a service who isn't there in time: the service, the teacher and Seguridad are told;
 *   * a student sent back to class who isn't confirmed in time: the teachers are asked «¿Ya llegó?» first; if
 *     nobody answers in 3 minutes, private.return_overdue tells the service, the teachers and Seguridad.
 * At the end of the day it closes what nobody closed, except the requests of support services (Soporte IT).
 */
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
    if r.reminders < 4 then
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
    perform private.close_notifications('#/turns/' || r.id);
    perform private.notify_tagged(
      array_cat(array[r.teacher_id], private.group_teacher_ids(r.school_id, r.group_name, array[r.teacher_id])),
      format('❓ ¿Ya llegó %s al salón?', v_who),
      format('Salió de %s hace %s min. Si está en tu clase, toca «Está en mi clase»; si no, «No ha llegado». Si nadie responde en 3 minutos, se avisa a Seguridad.', s.name, v_mins),
      '#/turns/' || r.id, 'turn-' || r.id, true);
  end loop;

  -- …and if nobody answers in 3 minutes, the service, the teachers and Seguridad are told.
  for r in
    select * from public.service_requests x
    where x.status = 'returning' and x.return_late_at is null and x.return_check_at < now() - interval '3 minutes'
    for update skip locked
  loop
    perform private.return_overdue(r, null);
  end loop;

  -- The end of the day: a return nobody confirmed stays as such; the rest, closed without an outcome. Support
  -- requests wait for the service.
  update public.service_requests x
  set status = case when x.status = 'returning' then 'done' else 'cancelled' end,
    outcome = case when x.status = 'returning' then 'unconfirmed' else 'expired' end,
    closed_at = now(), closed_by_name = 'Hallway', remind_at = null
  where x.status not in ('done', 'cancelled') and x.created_at < now() - interval '14 hours'
    and not exists (select 1 from public.school_services svc where svc.id = x.service_id and svc.mode = 'support');
end;
$$;

/**
 * The next step of a turn.
 *   The service: call (visit) · go («Voy en camino»: room and support) · arrived · return («Regresa al salón») ·
 *     finish with p_value picked_up | referred (visit) or attended | referred (room and support) · cancel.
 *   The teachers of the student: sent («Ya salió») · back («Llegó al salón») · take («Está conmigo», p_value:
 *     the room) · cancel (whoever asked or has the student, before the student leaves).
 *   Support: whoever asked hears «Voy en camino» and how it ended, and can cancel while nobody is on the way.
 *   On the way back to class, any teacher of the school can mark back («Está en mi clase»): the student may have
 *     gone to another class. The teachers asked «¿Ya llegó?» can answer missing («No ha llegado»): Seguridad is told now.
 */
create or replace function public.advance_turn(p_id bigint, p_step text, p_value text default null)
returns public.service_requests
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  r public.service_requests;
  s public.school_services;
  v_serves boolean;
  v_teacher boolean;
  v_support boolean;
  v_link text := '#/turns/' || p_id;
  v_tag text := 'turn-' || p_id;
  v_who text;
  v_teachers uuid[];
  v_group uuid[];
  v_position int;
  v_old text;
  v_anyone boolean;
begin
  select * into r from public.service_requests x where x.id = p_id and x.school_id = me.school_id for update;
  if r.id is null then raise exception 'No se encontró el turno.'; end if;
  select * into s from public.school_services x where x.id = r.service_id;
  v_support := s.mode = 'support';
  v_serves := me.role = any(s.roles);
  v_teacher := case when v_support then r.created_by = me.id or r.teacher_id = me.id
    else r.created_at > now() - interval '24 hours'
      and (r.created_by = me.id or r.teacher_id = me.id or r.group_name = any(coalesce(me.groups, '{}'))) end;
  -- A student on the way back may be in anybody's class.
  v_anyone := not v_support and p_step = 'back' and r.status = 'returning';
  if not (v_serves or v_teacher or v_anyone) then raise exception 'No se encontró el turno.'; end if;
  if r.status in ('done', 'cancelled') then raise exception 'Este turno ya terminó.'; end if;
  if v_support then
    -- "Proyector o pantalla (204)"
    v_who := coalesce((select d.reason from public.service_request_details d where d.request_id = r.id), 'el pedido')
      || coalesce(' (' || r.room || ')', '');
    v_group := '{}';
  else
    v_who := format('%s (%s)', r.student_name, r.group_name);
    v_group := private.group_teacher_ids(r.school_id, r.group_name, array[me.id, r.teacher_id]);
  end if;
  v_teachers := array_remove(array[r.teacher_id], me.id);
  v_old := r.status;

  if p_step = 'call' then
    if not v_serves then raise exception 'Solo % llama los turnos.', s.name; end if;
    if s.mode <> 'visit' then raise exception 'En % el profesional va al salón: toca «Voy en camino».', s.name; end if;
    if r.status <> 'waiting' then raise exception 'Este turno ya se llamó.'; end if;
    v_position := private.turn_position(r.id);
    -- The time to get there starts with «Ya salió»; until then, reminders.
    update public.service_requests
    set status = 'called', called_at = now(), due_at = null, remind_at = now() + interval '3 minutes', reminders = 0,
      handled_by = me.id, handled_by_name = me.full_name, out_of_order = coalesce(v_position, 1) > 1
    where id = r.id returning * into r;
    perform private.close_notifications(v_link);
    perform private.notify_tagged(v_teachers,
      format('📋 Envía a %s a %s', v_who, s.name),
      'Le toca ahora. Toca «Ya salió» cuando lo envíes. Si ya no está contigo, a los maestros de su grupo también les llegó el aviso.',
      v_link, v_tag, false);
    perform private.notify_tagged(v_group,
      format('📋 Llamaron a %s a %s', v_who, s.name),
      'Le toca ahora. Si está contigo, envíalo y toca «Ya salió».', v_link, v_tag, false);

  elsif p_step = 'go' then
    if not v_serves then raise exception 'Solo % marca que va en camino.', s.name; end if;
    if s.mode = 'visit' then raise exception 'En % el estudiante va a la oficina: toca «Llamar».', s.name; end if;
    if r.status <> 'waiting' then raise exception 'Ya alguien va en camino.'; end if;
    v_position := private.turn_position(r.id);
    update public.service_requests
    set status = 'on_the_way', on_the_way_at = now(), handled_by = me.id, handled_by_name = me.full_name,
      out_of_order = coalesce(v_position, 1) > 1
    where id = r.id returning * into r;
    perform private.close_notifications(v_link);
    if v_support then
      perform private.notify_tagged(v_teachers,
        format('📋 %s va en camino', s.name), format('Va %s por %s.', me.full_name, v_who), v_link, v_tag, false);
    else
      perform private.notify_tagged(v_teachers,
        format('📋 %s va a tu salón por %s', s.name, v_who), format('Va %s.', me.full_name), v_link, v_tag, false);
      perform private.notify_tagged(v_group,
        format('📋 %s va a buscar a %s', s.name, v_who),
        concat_ws(' ', case when r.room is not null then format('Va al salón %s.', r.room) end,
          'Si está contigo, toca «Está conmigo» y pon tu salón.'),
        v_link, v_tag, false);
    end if;

  elsif p_step = 'sent' then
    if not v_teacher then raise exception 'Lo marca el maestro que tiene al estudiante.'; end if;
    if r.status <> 'called' then raise exception 'Este turno no está esperando que salga el estudiante.'; end if;
    -- Whoever sends the student has them: the next notices go to them. The time to get there starts now.
    update public.service_requests
    set status = 'sent', sent_at = now(), due_at = now() + make_interval(mins => s.arrive_minutes), remind_at = null,
      teacher_id = me.id, teacher_name = me.full_name,
      room = case when teacher_id is distinct from me.id then coalesce(me.room, room) else room end
    where id = r.id returning * into r;
    perform private.close_notifications(v_link);

  elsif p_step = 'arrived' then
    if not v_serves then raise exception 'Lo marca %.', s.name; end if;
    if s.mode <> 'visit' or r.status not in ('waiting', 'called', 'sent') then
      raise exception 'Este turno no está esperando al estudiante.';
    end if;
    update public.service_requests
    set status = 'arrived', arrived_at = now(), remind_at = null,
      handled_by = coalesce(handled_by, me.id), handled_by_name = coalesce(handled_by_name, me.full_name)
    where id = r.id returning * into r;
    perform private.close_notifications(v_link);
    if r.late_at is not null then
      perform private.notify_tagged(
        array_cat(v_teachers, private.service_staff_ids(s.id, me.id)),
        format('✅ %s llegó a %s', v_who, s.name), format('Lo recibió %s.', me.full_name), v_link, v_tag, false);
    end if;
    perform private.end_turn_alert(r.id, format('Llegó a %s', s.name), me);

  elsif p_step = 'return' then
    if not v_serves then raise exception 'Lo marca %.', s.name; end if;
    if r.status <> 'arrived' then raise exception 'El estudiante no está en %.', s.name; end if;
    update public.service_requests
    set status = 'returning', returning_at = now(), due_at = now() + make_interval(mins => s.arrive_minutes)
    where id = r.id returning * into r;
    perform private.close_notifications(v_link);
    perform private.notify_tagged(v_teachers,
      format('📋 %s regresa al salón', v_who),
      format('Sale de %s. Toca «Llegó al salón» cuando llegue; tiene %s min.', s.name, s.arrive_minutes), v_link, v_tag, false);
    perform private.notify_tagged(v_group,
      format('📋 %s regresa al salón', v_who),
      format('Sale de %s. Si llega a tu salón, toca «Llegó al salón».', s.name), v_link, v_tag, false);

  elsif p_step = 'back' then
    if not (v_teacher or v_serves or v_anyone) then raise exception 'No se encontró el turno.'; end if;
    if r.status <> 'returning' then raise exception 'Este turno no está esperando que regrese el estudiante.'; end if;
    update public.service_requests
    set status = 'done', outcome = 'returned', closed_at = now(), closed_by_name = me.full_name,
      teacher_id = case when not v_serves then me.id else teacher_id end,
      teacher_name = case when not v_serves then me.full_name else teacher_name end
    where id = r.id returning * into r;
    perform private.close_notifications(v_link);
    if r.return_late_at is not null or r.return_check_at is not null then
      -- Everyone who was asked «¿Ya llegó?» or warned that the student hadn't got to class hears that they did.
      perform private.notify_tagged(
        private.uuid_minus(array_cat(array_cat(v_teachers, v_group), private.service_staff_ids(s.id, null)), array[me.id]),
        format('✅ %s llegó al salón', v_who),
        concat_ws(' ', 'Lo recibió ' || me.full_name, case when not v_serves then 'en el salón ' || me.room end) || '.',
        v_link, v_tag, false);
      perform private.end_turn_alert(r.id, 'Llegó al salón', me);
    else
      -- Whoever sent the student (they may be in another class now).
      perform private.notify_tagged(v_teachers,
        format('✅ %s llegó al salón', v_who),
        case when not v_serves then concat_ws(' ', 'Lo recibió ' || me.full_name, 'en el salón ' || me.room) || '.'
          else format('Lo marcó %s.', me.full_name) end,
        v_link, v_tag, false);
    end if;

  elsif p_step = 'missing' then
    -- «No ha llegado», from a teacher who was asked or from the service: no waiting for the 3 minutes.
    if v_support or not (v_teacher or v_serves) then raise exception 'No se encontró el turno.'; end if;
    if r.status <> 'returning' then raise exception 'Este turno no está esperando que regrese el estudiante.'; end if;
    if r.return_late_at is null then
      perform private.return_overdue(r, me.full_name);
      select * into r from public.service_requests x where x.id = p_id;
    end if;

  elsif p_step = 'finish' then
    if not v_serves then raise exception 'Lo marca %.', s.name; end if;
    if s.mode = 'visit' then
      if r.status <> 'arrived' then raise exception 'El estudiante no está en %.', s.name; end if;
      if p_value is null or p_value not in ('picked_up', 'referred') then raise exception 'Elige cómo terminó.'; end if;
    else
      if r.status not in ('waiting', 'on_the_way') then raise exception 'Este turno no está abierto.'; end if;
      if p_value is null or p_value not in ('attended', 'referred') then raise exception 'Elige cómo terminó.'; end if;
    end if;
    update public.service_requests
    set status = 'done', outcome = p_value, closed_at = now(), closed_by_name = me.full_name,
      handled_by = coalesce(handled_by, me.id), handled_by_name = coalesce(handled_by_name, me.full_name)
    where id = r.id returning * into r;
    perform private.close_notifications(v_link);
    perform private.notify_tagged(v_teachers,
      case
        when v_support and p_value = 'attended' then format('✅ %s resolvió %s', s.name, v_who)
        when v_support then format('📋 %s: %s necesita seguimiento', s.name, v_who)
        when p_value = 'picked_up' then format('📋 %s: lo recogieron en %s', v_who, s.name)
        when p_value = 'referred' then format('📋 %s: %s lo refirió', v_who, s.name)
        else format('✅ %s atendió a %s', s.name, v_who) end,
      case p_value when 'picked_up' then 'No regresa al salón. ' else '' end || format('Lo marcó %s.', me.full_name),
      v_link, v_tag, false);

  elsif p_step = 'cancel' then
    if not (v_serves or ((r.created_by = me.id or r.teacher_id = me.id) and r.status in ('waiting', 'called'))) then
      raise exception '%', case when v_support then format('%s ya va en camino: ahora solo %s puede cancelarlo.', s.name, s.name)
        else format('Solo quien lo pidió (antes de que salga el estudiante) o %s pueden cancelarlo.', s.name) end;
    end if;
    update public.service_requests
    set status = 'cancelled', outcome = 'cancelled', closed_at = now(), closed_by_name = me.full_name, remind_at = null
    where id = r.id returning * into r;
    perform private.close_notifications(v_link);
    perform private.end_turn_alert(r.id, 'Se canceló el turno', me);
    perform private.notify_tagged(
      case when v_serves then
          -- Once called, the teachers of the group heard about it too.
          case when v_old = 'called' then private.uuid_minus(array_cat(v_teachers, v_group), array[me.id]) else v_teachers end
        -- The service only needs to hear it once it had called the student (or was on the way).
        when v_old <> 'waiting' then private.service_staff_ids(s.id, me.id)
        else '{}'::uuid[] end,
      format('%s cancelado: %s', case when v_support then 'Pedido' else 'Turno' end, v_who),
      format('%s · lo canceló %s.', s.name, me.full_name), v_link, v_tag, false);

  elsif p_step = 'take' then
    if v_support then raise exception 'Paso no válido.'; end if;
    if not v_teacher then raise exception 'Solo los maestros del grupo pueden hacerlo.'; end if;
    if r.status not in ('waiting', 'called', 'on_the_way', 'returning') then raise exception 'Ahora no se puede cambiar quién lo tiene.'; end if;
    if r.teacher_id = me.id then return r; end if;
    update public.service_requests
    set teacher_id = me.id, teacher_name = me.full_name,
      room = coalesce(private.clean_text(regexp_replace(coalesce(p_value, ''), '\s+', ' ', 'g'), 40, 'El salón'), me.room, room)
    where id = r.id returning * into r;
    if v_old = 'called' then perform private.close_notifications(v_link); end if;
    perform private.notify_tagged(v_teachers,
      format('📋 %s está con %s', v_who, me.full_name),
      format('Los avisos de este turno de %s le llegan ahora a %s.', s.name, me.full_name), v_link, v_tag, false);
    -- Whoever is on the way goes to the new room.
    if v_old = 'on_the_way' then
      perform private.notify_tagged(array_remove(array[r.handled_by], me.id),
        case when r.room is not null then format('📋 %s está ahora en el salón %s', v_who, r.room)
          else format('📋 %s está ahora con %s', v_who, me.full_name) end,
        format('Está con %s.', me.full_name), v_link, v_tag, true);
    end if;

  else
    raise exception 'Paso no válido.';
  end if;
  return r;
end;
$$;

/**
 * The students on their way back to class right now, for any teacher of the school: the student may arrive at a
 * class whose teacher didn't get the notice. Only the name, the group and since when; never the service or why.
 */
create or replace function public.returning_students()
returns table (id bigint, student_name text, group_name text, returning_at timestamptz, due_at timestamptz, asked boolean, late boolean)
language sql stable security definer set search_path = ''
as $$
  select r.id, r.student_name, r.group_name, r.returning_at, r.due_at, r.return_check_at is not null, r.return_late_at is not null
  from public.service_requests r
  join public.school_services s on s.id = r.service_id
  where r.school_id = private.my_school_id() and r.status = 'returning' and s.mode <> 'support'
    and r.created_at > now() - interval '14 hours'
  order by r.returning_at
$$;

revoke execute on function public.returning_students() from public, anon;
grant execute on function public.returning_students() to authenticated;
