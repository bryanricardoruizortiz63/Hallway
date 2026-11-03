-- Absences of the people who attend a service: they show in its availability, and when everyone is out the service
-- can't be asked for a turn (Soporte IT with one person, for example). With part of them out, the app says who and that
-- it may take longer.

/** Absent at this local time (the phone's): an absence not cancelled that covers the day, all of it or that hour. */
create or replace function private.absent_at(p_user uuid, p_local timestamp)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.absences a
    where a.user_id = p_user and a.status <> 'cancelled'
      and p_local::date between a.start_date and a.end_date
      and (not a.partial
        or (p_local::time >= coalesce(a.start_time, time '00:00') and (a.end_time is null or p_local::time < a.end_time)))
  )
$$;

revoke execute on function private.absent_at(uuid, timestamp) from public, anon, authenticated;

-- Same as in 20261117000051, with each person's absences around today.
create or replace function public.services_overview()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'mode', s.mode, 'arrive_minutes', s.arrive_minutes,
        'roles', to_jsonb(s.roles), 'reasons', to_jsonb(s.reasons), 'active', s.active,
        'serves', private.roles_of(me) && s.roles,
        'waiting', (select count(*) from public.service_requests x where x.service_id = s.id and x.status = 'waiting'),
        'staff', (
          select coalesce(jsonb_agg(jsonb_build_object(
              'id', p.id, 'name', p.full_name, 'status', private.staff_status(st),
              'until', case when private.staff_status(st) <> 'available' then st.until end,
              -- Absences around today (the app compares them with the phone's clock): who is out, all day or for a while.
              'absences', (
                select coalesce(jsonb_agg(jsonb_build_object(
                    'start_date', a.start_date, 'end_date', a.end_date, 'partial', a.partial,
                    'start_time', a.start_time, 'end_time', a.end_time) order by a.start_date), '[]'::jsonb)
                from public.absences a
                where a.user_id = p.id and a.status <> 'cancelled'
                  and a.end_date >= current_date - 1 and a.start_date <= current_date + 1))
            order by p.full_name), '[]'::jsonb)
          from public.profiles p
          left join public.service_staff_status st on st.user_id = p.id
          where p.school_id = s.school_id and p.active and private.roles_of(p) && s.roles)
      ) order by s.position, s.name)
    from public.school_services s
    where s.school_id = me.school_id and (s.active or private.can(me, 'services'))
  ), '[]'::jsonb);
end;
$$;

-- Same as in 20261117000051, and refused when everyone who attends it is absent (p_local: the phone's time).
drop function public.request_service(bigint, bigint, text, text, text, int, text, text, boolean);
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

  v_here := coalesce(p_here, false) and private.roles_of(me) && s.roles and s.mode = 'visit';
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

revoke execute on function public.request_service(bigint, bigint, text, text, text, int, text, text, boolean, timestamp) from public, anon;
grant execute on function public.request_service(bigint, bigint, text, text, text, int, text, text, boolean, timestamp) to authenticated;
