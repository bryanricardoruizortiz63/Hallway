-- Quien cubre a un maestro recibe los turnos de los grupos que cubre. While a substitute covers a teacher (Cobertura of
-- an absence or a school activity: that day, those groups and, if given, those hours), they count as a teacher of
-- those groups for the services' turns (Enfermería, Trabajo Social…): they hear «Llamaron a … a Enfermería», «… regresa
-- al salón» and «No ha llegado», can tap «Ya salió», «Está conmigo» or «Llegó al salón», and see those turns as the
-- group's own teachers do. A coverage without groups is for every group of the absent teacher. Its hours count from 15
-- minutes before to 15 minutes after.

/** The local time of the school (its time zone). */
create or replace function private.school_local_now(p_school uuid)
returns timestamp
language sql stable security definer set search_path = ''
as $$
  select now() at time zone coalesce((select st.time_zone from public.school_settings st where st.school_id = p_school), 'America/Puerto_Rico')
$$;

/** Each person covering a teacher right now, with the groups they cover. */
create or replace function private.covers_now(p_school uuid)
returns table (substitute_id uuid, group_name text)
language sql stable security definer set search_path = ''
as $$
  select distinct (c.value->>'substitute_id')::uuid, g
  from public.absences a
  join public.profiles t on t.id = a.user_id
  cross join lateral (select private.school_local_now(a.school_id) as n) l
  cross join lateral jsonb_array_elements(a.covers) c
  cross join lateral unnest(case when jsonb_array_length(coalesce(c.value->'groups', '[]'::jsonb)) > 0
      then array(select jsonb_array_elements_text(c.value->'groups')) else coalesce(t.groups, '{}') end) g
  where a.school_id = p_school and a.status <> 'cancelled' and a.covers <> '[]'::jsonb
    and l.n::date between a.start_date and a.end_date
    and nullif(c.value->>'substitute_id', '') is not null
    and (jsonb_array_length(coalesce(c.value->'days', '[]'::jsonb)) = 0 or c.value->'days' ? to_char(l.n::date, 'YYYY-MM-DD'))
    and (coalesce(nullif(c.value->>'start_time', '')::time, case when a.partial then a.start_time end) is null
      or l.n::time >= coalesce(nullif(c.value->>'start_time', '')::time, a.start_time) - interval '15 minutes')
    and (coalesce(nullif(c.value->>'end_time', '')::time, case when a.partial then a.end_time end) is null
      or l.n::time <= coalesce(nullif(c.value->>'end_time', '')::time, a.end_time) + interval '15 minutes')
$$;

/** The groups a person teaches: their own and, while covering, the ones they cover. */
create or replace function private.teaching_groups(me public.profiles)
returns text[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(me.groups, '{}') || coalesce((
    select array_agg(distinct c.group_name) from private.covers_now(me.school_id) c where c.substitute_id = me.id), '{}')
$$;

/** The teachers of a group: who has it, and who covers it right now. */
create or replace function private.group_teacher_ids(p_school uuid, p_group text, p_exclude uuid[])
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(distinct x.id), '{}')
  from (
    select p.id from public.profiles p
    where p.school_id = p_school and p.active and p_group = any(p.groups)
    union
    select c.substitute_id from private.covers_now(p_school) c
    join public.profiles p on p.id = c.substitute_id and p.active
    where c.group_name = p_group
  ) x
  where not x.id = any(array_remove(coalesce(p_exclude, '{}'), null))
$$;
revoke execute on function private.group_teacher_ids(uuid, text, uuid[]), private.covers_now(uuid) from public, anon, authenticated;
revoke execute on function private.teaching_groups(public.profiles), private.school_local_now(uuid) from public, anon;
grant execute on function private.teaching_groups(public.profiles), private.school_local_now(uuid) to authenticated;

/** The groups this person covers right now (the app shows them the teacher's buttons on those turns). */
create or replace function public.my_covered_groups()
returns text[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(distinct c.group_name order by c.group_name), '{}')
  from public.profiles p cross join lateral private.covers_now(p.school_id) c
  where p.id = (select auth.uid()) and c.substitute_id = p.id
$$;
revoke execute on function public.my_covered_groups() from public, anon;
grant execute on function public.my_covered_groups() to authenticated;

-- Seeing the turns: the group's teachers, now also whoever covers the group (same as in 20261202000066 otherwise).
drop policy if exists "Ver turnos" on public.service_requests;
create policy "Ver turnos" on public.service_requests for select to authenticated using (
  school_id = (select private.my_school_id()) and (
    private.serves(service_id)
    or (select private.sees_all_turns())
    or (created_by = (select auth.uid()) and status <> all (array['done', 'cancelled']))
    or (created_at > now() - interval '24 hours' and (
      created_by = (select auth.uid()) or teacher_id = (select auth.uid())
      or group_name = any (coalesce((select private.teaching_groups(p) from public.profiles p where p.id = (select auth.uid())), '{}'::text[]))))
  )
);

-- Seeing a student (alerts, pickups): the same (as in 20261009000012 otherwise).
create or replace function private.can_see_student(p_id bigint, p_group text, p_created_by uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_created_by = auth.uid()
    or private.has_perm('security') or private.has_perm('absences')
    or p_group = any(coalesce((select private.teaching_groups(p) from public.profiles p where p.id = auth.uid()), '{}'))
    or exists (select 1 from public.student_alerts a where a.student_id = p_id and (a.audience = 'all' or a.created_by = auth.uid()))
    or exists (select 1 from public.student_pickups k where k.student_id = p_id and k.created_by = auth.uid())
$$;

-- «Ya salió», «Está conmigo», «Llegó al salón»: also whoever covers the group (as in 20261124000058 otherwise).
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
  v_mode text;
begin
  select * into r from public.service_requests x where x.id = p_id and x.school_id = me.school_id for update;
  if r.id is null then raise exception 'No se encontró el turno.'; end if;
  select * into s from public.school_services x where x.id = r.service_id;
  v_support := s.mode = 'support';
  -- «Decide quien atiende»: the first step chooses for this turn (Llamar / Ya está aquí: to the office; Voy en camino or
  -- Ya lo atendí: to the room).
  v_mode := case when s.mode <> 'either' then s.mode
    when r.flow is not null then r.flow
    when p_step in ('call', 'arrived') then 'visit'
    else 'room' end;
  v_serves := private.roles_of(me) && s.roles;
  v_teacher := case when v_support then r.created_by = me.id or r.teacher_id = me.id
    else r.created_at > now() - interval '24 hours'
      and (r.created_by = me.id or r.teacher_id = me.id or r.group_name = any(private.teaching_groups(me))) end;
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
  if s.mode = 'either' and r.flow is null and p_step in ('call', 'arrived', 'go', 'finish') then
    update public.service_requests set flow = v_mode where id = r.id returning * into r;
  end if;

  if p_step = 'call' then
    if not v_serves then raise exception 'Solo % llama los turnos.', s.name; end if;
    if v_mode <> 'visit' then raise exception 'En % el profesional va al salón: toca «Voy en camino».', s.name; end if;
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
    if v_mode = 'visit' then raise exception 'En % el estudiante va a la oficina: toca «Llamar».', s.name; end if;
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
    if v_mode <> 'visit' or r.status not in ('waiting', 'called', 'sent') then
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
    if v_mode = 'visit' then
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
