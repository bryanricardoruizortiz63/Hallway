-- Services whose staff decide, turn by turn, whether to call the student to the office (like Enfermería) or go to the
-- room (like Trabajo Social): mode «either». The first step of each turn chooses for it, kept in service_requests.flow,
-- and the turn then goes like that mode. service_mode in the view and in live_turn is that turn's way («either» while
-- nobody has chosen).

alter table public.school_services drop constraint if exists school_services_mode_check;
alter table public.school_services add constraint school_services_mode_check check (mode in ('visit', 'room', 'either', 'support'));
alter table public.service_requests add column if not exists flow text check (flow in ('visit', 'room'));

create or replace view public.service_requests_v with (security_invoker = true) as
  select r.id, r.school_id, r.service_id, r.student_id, r.student_name, r.student_key, r.group_name, r.room,
    r.severity, r.status, r.outcome, r.teacher_id, r.teacher_name, r.created_by, r.created_by_name, r.created_at,
    r.handled_by, r.handled_by_name, r.out_of_order, r.called_at, r.sent_at, r.due_at, r.late_at, r.arrived_at,
    r.on_the_way_at, r.returning_at, r.closed_at, r.closed_by_name,
    s.name as service_name, case when s.mode = 'either' then coalesce(r.flow, 'either') else s.mode end as service_mode, d.reason, d.note,
    case when r.status = 'waiting' then private.turn_level(r.severity, r.created_at) end as level,
    private.turn_position(r.id) as position,
    r.return_late_at,
    d.resolution,
    r.return_check_at,
    r.received_at,
    r.received_by_name
  from public.service_requests r
  join public.school_services s on s.id = r.service_id
  left join public.service_request_details d on d.request_id = r.id;

-- Same as in 20261117000051, with each turn's own way for «either».
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

-- Same as in 20261121000055, a visit noted on arrival goes to the office.
create or replace function public.request_service(
  p_service_id bigint, p_student_id bigint, p_name text, p_group text, p_room text,
  p_severity int, p_reason text, p_note text, p_here boolean default false, p_local timestamp default null
)
returns public.service_requests
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  s public.school_services;
  st public.students;
  r public.service_requests;
  v_room text := private.clean_text(regexp_replace(coalesce(p_room, ''), '\s+', ' ', 'g'), 40, 'El salón');
  v_reason text := private.clean_text(p_reason, 40, 'El motivo');
  v_note text := private.clean_text(p_note, 500, 'La nota');
  v_here boolean;
begin
  select * into s from public.school_services x where x.id = p_service_id and x.school_id = me.school_id and x.active;
  if s.id is null then raise exception 'Ese servicio no está disponible.'; end if;
  -- Everyone who attends the service is absent at this time (the phone's own clock): there is nobody to receive it.
  if p_local is not null and abs(extract(epoch from (p_local - (now() at time zone 'utc')))) < 36 * 3600
    and not (private.roles_of(me) && s.roles)
    and exists (select 1 from public.profiles p where p.school_id = s.school_id and p.active and private.roles_of(p) && s.roles)
    and not exists (
      select 1 from public.profiles p
      where p.school_id = s.school_id and p.active and private.roles_of(p) && s.roles and not private.absent_at(p.id, p_local))
  then
    raise exception '% no está disponible en este momento: el personal del servicio se encuentra ausente. Para una situación urgente, comunícate con la oficina.', s.name;
  end if;
  if p_severity is null or p_severity not between 1 and 4 then raise exception 'Elige la gravedad.'; end if;
  if cardinality(s.reasons) > 0 and (v_reason is null or not v_reason = any(s.reasons)) then
    raise exception 'Elige el motivo.';
  end if;
  if (select count(*) from public.service_requests x where x.created_by = me.id and x.created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Pediste muchos turnos en la última hora. Llama a la oficina.';
  end if;

  if s.mode = 'support' then
    v_room := coalesce(v_room, me.room);
    if v_room is null then raise exception 'Escribe dónde es (tu salón u oficina).'; end if;
    -- The same thing, still open: no second request.
    select x.* into r from public.service_requests x
    join public.service_request_details d on d.request_id = x.id
    where x.service_id = s.id and x.created_by = me.id and x.status not in ('done', 'cancelled')
      and d.reason is not distinct from v_reason and lower(x.room) = lower(v_room)
    limit 1;
    if r.id is not null then
      raise exception 'Ya pediste ayuda a % por «%» en %: sigue abierto.', s.name, coalesce(v_reason, 'esto'), v_room;
    end if;
    insert into public.service_requests (
      school_id, service_id, room, severity, status, teacher_id, teacher_name, created_by, created_by_name
    ) values (
      me.school_id, s.id, v_room, p_severity, 'waiting', me.id, me.full_name, me.id, me.full_name
    )
    returning * into r;
    insert into public.service_request_details (request_id, school_id, service_id, created_by, reason, note)
    values (r.id, me.school_id, s.id, me.id, v_reason, v_note);
    perform private.notify_tagged(private.service_staff_ids(s.id, me.id),
      format('📋 %s: %s', s.name, coalesce(v_reason, 'pedido de ayuda')),
      concat_ws(' · ', private.severity_text(p_severity), case when v_room ~ '^[0-9]' then 'salón ' || v_room else v_room end,
        v_note, 'pidió ' || me.full_name) || '.',
      '#/turns/' || r.id, 'turn-' || r.id, true);
    return r;
  end if;

  v_here := coalesce(p_here, false) and private.roles_of(me) && s.roles and s.mode in ('visit', 'either');
  st := private.note_student(me, p_student_id, p_name, p_group);
  select * into r from public.service_requests x
  where x.service_id = s.id and x.student_key = st.name_key and x.group_name = st.group_name
    and x.status not in ('done', 'cancelled')
  limit 1;
  if r.id is not null then
    raise exception 'Ya hay un turno abierto para % (%) en %, pedido por %.', st.name, st.group_name, s.name, r.created_by_name;
  end if;

  insert into public.service_requests (
    school_id, service_id, student_id, student_name, student_key, group_name, room, severity, status,
    teacher_id, teacher_name, created_by, created_by_name, handled_by, handled_by_name, arrived_at, flow
  ) values (
    me.school_id, s.id, st.id, st.name, st.name_key, st.group_name,
    coalesce(v_room, case when not v_here then me.room end), p_severity,
    case when v_here then 'arrived' else 'waiting' end,
    case when not v_here then me.id end, case when not v_here then me.full_name end,
    me.id, me.full_name,
    case when v_here then me.id end, case when v_here then me.full_name end,
    case when v_here then now() end,
    case when v_here and s.mode = 'either' then 'visit' end
  )
  returning * into r;
  insert into public.service_request_details (request_id, school_id, service_id, created_by, reason, note)
  values (r.id, me.school_id, s.id, me.id, v_reason, v_note);

  if not v_here then
    perform private.notify_tagged(private.service_staff_ids(s.id, me.id),
      format('📋 %s: %s (%s)', s.name, st.name, st.group_name),
      concat_ws(' · ', private.severity_text(p_severity), v_reason, 'salón ' || r.room, 'pidió ' || me.full_name) || '.',
      '#/turns/' || r.id, 'turn-' || r.id, true);
  end if;
  return r;
end;
$$;

-- Same as in 20261025000028, with «either».
create or replace function public.save_service(
  p_id bigint, p_name text, p_mode text, p_arrive_minutes int, p_roles text[], p_reasons text[], p_active boolean
)
returns public.school_services
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  s public.school_services;
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_roles text[];
  v_reasons text[];
begin
  if not private.can(me, 'services') then raise exception 'No tienes permiso para cambiar los servicios.'; end if;
  if char_length(v_name) < 2 then raise exception 'Escribe el nombre del servicio.'; end if;
  if char_length(v_name) > 40 then raise exception 'El nombre es demasiado largo (máx. 40 caracteres).'; end if;
  if p_mode is null or p_mode not in ('visit', 'room', 'either', 'support') then raise exception 'Elige cómo funciona el servicio.'; end if;
  if p_arrive_minutes is null or p_arrive_minutes not between 1 and 30 then
    raise exception 'El tiempo para llegar debe ser de 1 a 30 minutos.';
  end if;
  select coalesce(array_agg(r.key order by r.position, r.name), '{}') into v_roles
  from public.school_roles r
  where r.school_id = me.school_id and not r.system and r.key = any(coalesce(p_roles, '{}'));
  if cardinality(v_roles) = 0 then raise exception 'Elige qué rol atiende el servicio.'; end if;
  if cardinality(v_roles) > 10 then raise exception 'Hasta 10 roles por servicio.'; end if;
  -- One per line, without repeats (case doesn't matter), in the order written.
  select coalesce(array_agg(x.t order by x.i), '{}') into v_reasons
  from (
    select distinct on (lower(c.t)) c.t, c.i
    from (
      select regexp_replace(btrim(u.raw), '\s+', ' ', 'g') as t, u.i
      from unnest(coalesce(p_reasons, '{}'::text[])) with ordinality as u(raw, i)
    ) c
    where c.t <> ''
    order by lower(c.t), c.i
  ) x;
  if exists (select 1 from unnest(v_reasons) t where char_length(t) > 40) then
    raise exception 'Cada motivo puede tener hasta 40 caracteres.';
  end if;
  if cardinality(v_reasons) > 20 then raise exception 'Hasta 20 motivos por servicio.'; end if;

  begin
    if p_id is null then
      if (select count(*) from public.school_services x where x.school_id = me.school_id) >= 12 then
        raise exception 'Llegaste al máximo de servicios (12).';
      end if;
      insert into public.school_services (school_id, name, mode, arrive_minutes, roles, reasons, active, position)
      values (me.school_id, v_name, p_mode, p_arrive_minutes, v_roles, v_reasons, coalesce(p_active, true),
        coalesce((select max(x.position) + 10 from public.school_services x where x.school_id = me.school_id), 10))
      returning * into s;
    else
      select * into s from public.school_services x where x.id = p_id and x.school_id = me.school_id for update;
      if s.id is null then raise exception 'No se encontró el servicio.'; end if;
      if s.mode <> p_mode and exists (
        select 1 from public.service_requests x where x.service_id = s.id and x.status not in ('done', 'cancelled')
      ) then
        raise exception 'Hay turnos abiertos en %. Termínalos antes de cambiar cómo funciona.', s.name;
      end if;
      update public.school_services
      set name = v_name, mode = p_mode, arrive_minutes = p_arrive_minutes, roles = v_roles, reasons = v_reasons,
        active = coalesce(p_active, active)
      where id = s.id
      returning * into s;
    end if;
  exception when unique_violation then
    raise exception 'Ya hay un servicio llamado «%».', v_name;
  end;
  return s;
end;
$$;

-- Same as in 20261123000057, with the turn's own way.
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
  if not (private.can(me, 'live') or private.can(me, 'summary') or private.serves(r.service_id)) then
    raise exception 'No tienes permiso para ver este turno.';
  end if;
  select jsonb_build_object(
    'id', r.id, 'service_id', r.service_id, 'service_name', s.name, 'service_mode', case when s.mode = 'either' then coalesce(r.flow, 'either') else s.mode end,
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
