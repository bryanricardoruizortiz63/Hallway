-- Turnos llamativos: el aviso de un turno nuevo al servicio (Enfermería, Trabajo Social, Soporte IT…) es urgente
-- sea cual sea la gravedad, no solo en la 4. Se queda en pantalla (Android), vibra largo, se repite cada minuto
-- hasta 15 minutos (private.repeat_urgent) y suena como alarma con la app abierta, hasta que alguien del servicio
-- lo abre o lo atiende (cada paso del turno cierra los avisos: private.close_notifications).
-- Solo cambia el último argumento de los dos private.notify_tagged; lo demás es igual que en 20261023000026.


/**
 * A teacher asks for a turn. p_here: the professional notes a student who came on their own and is already
 * in the office (services where the student goes). Support services (Soporte IT): no student; the room is where
 * the help is needed (the person's room by default) and the notices go to whoever asked.
 */
create or replace function public.request_service(
  p_service_id bigint, p_student_id bigint, p_name text, p_group text, p_room text,
  p_severity int, p_reason text, p_note text, p_here boolean default false
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

  v_here := coalesce(p_here, false) and me.role = any(s.roles) and s.mode = 'visit';
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
    teacher_id, teacher_name, created_by, created_by_name, handled_by, handled_by_name, arrived_at
  ) values (
    me.school_id, s.id, st.id, st.name, st.name_key, st.group_name,
    coalesce(v_room, case when not v_here then me.room end), p_severity,
    case when v_here then 'arrived' else 'waiting' end,
    case when not v_here then me.id end, case when not v_here then me.full_name end,
    me.id, me.full_name,
    case when v_here then me.id end, case when v_here then me.full_name end,
    case when v_here then now() end
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
