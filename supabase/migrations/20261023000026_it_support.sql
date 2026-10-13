-- Turnos for the staff: Soporte IT.
--   * A new kind of service, "support": the help is for the person who asks, not for a student. The teacher
--     picks what's wrong (a reason of the service: Proyector, Computadora, Internet…), how serious it is, where
--     (their room by default) and a note. The queue, the professionals' status, «Voy en camino», the panel with
--     its Excel and the live board work as for the other services.
--   * It ends as «Resuelto» or «Necesita seguimiento», with an optional note of what was done (resolution),
--     which goes to the panel and the Excel.
--   * A support request doesn't close itself at the end of the day: it stays in the queue until the service
--     handles it, and whoever asked keeps seeing it while it's open.
--   * Every school gets the service «Soporte IT», attended by the new role «Coordinador(a) de IT» (no permissions,
--     no coverage). Both can be renamed, and other roles added, in Servicios and Roles y permisos.

-- ---------------------------------------------------------------------------
-- The new kind of service, and requests without a student
-- ---------------------------------------------------------------------------

alter table public.school_services drop constraint school_services_mode_check;
alter table public.school_services add constraint school_services_mode_check check (mode in ('visit', 'room', 'support'));

alter table public.service_requests
  alter column student_name drop not null,
  alter column student_key drop not null,
  alter column group_name drop not null;

-- What the service did (support): only the service and whoever asked see it, like the reason and the note.
alter table public.service_request_details add column resolution text check (char_length(resolution) <= 300);

-- The view picks up the new column (at the end, so the view can be replaced in place).
create or replace view public.service_requests_v with (security_invoker = true) as
  select r.id, r.school_id, r.service_id, r.student_id, r.student_name, r.student_key, r.group_name, r.room,
    r.severity, r.status, r.outcome, r.teacher_id, r.teacher_name, r.created_by, r.created_by_name, r.created_at,
    r.handled_by, r.handled_by_name, r.out_of_order, r.called_at, r.sent_at, r.due_at, r.late_at, r.arrived_at,
    r.on_the_way_at, r.returning_at, r.closed_at, r.closed_by_name,
    s.name as service_name, s.mode as service_mode, d.reason, d.note,
    case when r.status = 'waiting' then private.turn_level(r.severity, r.created_at) end as level,
    private.turn_position(r.id) as position,
    r.return_late_at,
    d.resolution
  from public.service_requests r
  join public.school_services s on s.id = r.service_id
  left join public.service_request_details d on d.request_id = r.id;

-- Whoever asked keeps seeing their request (and its reason) while it's open, even after 24 hours.
alter policy "Ver turnos" on public.service_requests
  using (school_id = (select private.my_school_id()) and (
    private.serves(service_id)
    or (created_by = (select auth.uid()) and status not in ('done', 'cancelled'))
    or (created_at > now() - interval '24 hours' and (
      created_by = (select auth.uid()) or teacher_id = (select auth.uid())
      or group_name = any(coalesce((select p.groups from public.profiles p where p.id = (select auth.uid())), '{}'))))));

alter policy "Ver motivo del turno" on public.service_request_details
  using (school_id = (select private.my_school_id()) and (
    private.serves(service_id)
    or (created_by = (select auth.uid()) and (created_at > now() - interval '24 hours'
      or exists (select 1 from public.service_requests r where r.id = request_id and r.status not in ('done', 'cancelled'))))));

-- ---------------------------------------------------------------------------
-- Soporte IT and its role, in every school
-- ---------------------------------------------------------------------------

create or replace function private.add_default_roles(p_school uuid)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.school_roles (school_id, key, name, permissions, coverage, system, position) values
    (p_school, 'admin', 'Administración', array['absences', 'staff', 'settings', 'messages', 'reports', 'live', 'calendar', 'security', 'visitors', 'maintenance'], false, true, 0),
    (p_school, 'director', 'Director(a)', array['absences', 'staff', 'settings', 'messages', 'reports', 'live', 'calendar', 'security', 'visitors'], true, false, 10),
    (p_school, 'secretary', 'Secretaría', array['absences', 'live', 'calendar', 'security', 'visitors'], true, false, 20),
    (p_school, 'teacher', 'Maestro(a)', '{}', true, false, 30),
    (p_school, 'facultad', 'Facultad', '{}', true, false, 40),
    (p_school, 'enfermeria', 'Enfermería', '{}', false, false, 50),
    (p_school, 'trabajo_social', 'Trabajo Social', '{}', false, false, 55),
    (p_school, 'mantenimiento', 'Mantenimiento', array['maintenance'], false, false, 60),
    (p_school, 'it', 'Coordinador(a) de IT', '{}', false, false, 65),
    (p_school, 'seguridad', 'Seguridad', array['security', 'visitors'], false, false, 70)
  on conflict do nothing
$$;

create or replace function private.add_default_services(p_school uuid)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.school_services (school_id, name, mode, arrive_minutes, roles, reasons, position) values
    (p_school, 'Enfermería', 'visit', 5, array['enfermeria'],
      array['Dolor de cabeza', 'Dolor de estómago', 'Fiebre o malestar', 'Golpe o herida', 'Náuseas o vómito',
        'Asma o respiración', 'Medicamento', 'Otro'], 10),
    (p_school, 'Trabajo Social', 'room', 5, array['trabajo_social'],
      array['Conducta', 'Situación emocional', 'Conflicto con compañeros', 'Situación familiar', 'Asistencia', 'Otro'], 20),
    (p_school, 'Soporte IT', 'support', 5, array['it'],
      array['Proyector o pantalla', 'Computadora o laptop', 'Internet o Wi-Fi', 'Impresora', 'Audio o micrófono',
        'Cuenta o contraseña', 'Programa o plataforma', 'Otro'], 30)
  on conflict do nothing
$$;

-- The schools that already exist get only what's new (not the roles or services they removed).
insert into public.school_roles (school_id, key, name, permissions, coverage, system, position)
select id, 'it', 'Coordinador(a) de IT', '{}', false, false, 65 from public.schools
on conflict do nothing;

insert into public.school_services (school_id, name, mode, arrive_minutes, roles, reasons, position)
select id, 'Soporte IT', 'support', 5, array['it'],
  array['Proyector o pantalla', 'Computadora o laptop', 'Internet o Wi-Fi', 'Impresora', 'Audio o micrófono',
    'Cuenta o contraseña', 'Programa o plataforma', 'Otro'], 30
from public.schools
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Services: the new kind can be chosen
-- ---------------------------------------------------------------------------

/** Adds (p_id null) or changes a service. A service with turns isn't deleted: it's deactivated. */
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
  if not private.can(me, 'settings') then raise exception 'No tienes permiso para cambiar los servicios.'; end if;
  if char_length(v_name) < 2 then raise exception 'Escribe el nombre del servicio.'; end if;
  if char_length(v_name) > 40 then raise exception 'El nombre es demasiado largo (máx. 40 caracteres).'; end if;
  if p_mode is null or p_mode not in ('visit', 'room', 'support') then raise exception 'Elige cómo funciona el servicio.'; end if;
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

-- ---------------------------------------------------------------------------
-- Asking
-- ---------------------------------------------------------------------------

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
      '#/turns/' || r.id, 'turn-' || r.id, p_severity = 4);
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
      '#/turns/' || r.id, 'turn-' || r.id, p_severity = 4);
  end if;
  return r;
end;
$$;

-- ---------------------------------------------------------------------------
-- Steps
-- ---------------------------------------------------------------------------

/**
 * The next step of a turn.
 *   The service: call (visit) · go («Voy en camino»: room and support) · arrived · return («Regresa al salón») ·
 *     finish with p_value picked_up | referred (visit) or attended | referred (room and support) · cancel.
 *   The teachers of the student: sent («Ya salió») · back («Llegó al salón») · take («Está conmigo», p_value:
 *     the room) · cancel (whoever asked or has the student, before the student leaves).
 *   Support: whoever asked hears «Voy en camino» and how it ended, and can cancel while nobody is on the way.
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
begin
  select * into r from public.service_requests x where x.id = p_id and x.school_id = me.school_id for update;
  if r.id is null then raise exception 'No se encontró el turno.'; end if;
  select * into s from public.school_services x where x.id = r.service_id;
  v_support := s.mode = 'support';
  v_serves := me.role = any(s.roles);
  v_teacher := case when v_support then r.created_by = me.id or r.teacher_id = me.id
    else r.created_at > now() - interval '24 hours'
      and (r.created_by = me.id or r.teacher_id = me.id or r.group_name = any(coalesce(me.groups, '{}'))) end;
  if not (v_serves or v_teacher) then raise exception 'No se encontró el turno.'; end if;
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
    if not (v_teacher or v_serves) then raise exception 'No se encontró el turno.'; end if;
    if r.status <> 'returning' then raise exception 'Este turno no está esperando que regrese el estudiante.'; end if;
    update public.service_requests
    set status = 'done', outcome = 'returned', closed_at = now(), closed_by_name = me.full_name,
      teacher_id = case when v_teacher then me.id else teacher_id end,
      teacher_name = case when v_teacher then me.full_name else teacher_name end
    where id = r.id returning * into r;
    perform private.close_notifications(v_link);
    if r.return_late_at is not null then
      -- Everyone who was warned that the student hadn't got to class hears that they did.
      perform private.notify_tagged(
        private.uuid_minus(array_cat(array_cat(v_teachers, v_group), private.service_staff_ids(s.id, null)), array[me.id]),
        format('✅ %s llegó al salón', v_who), format('Lo recibió %s.', me.full_name), v_link, v_tag, false);
      perform private.end_turn_alert(r.id, 'Llegó al salón', me);
    else
      -- Whoever sent the student (they may be in another class now).
      perform private.notify_tagged(v_teachers,
        format('✅ %s llegó al salón', v_who),
        case when v_teacher then concat_ws(' ', 'Lo recibió ' || me.full_name, 'en el salón ' || me.room) || '.'
          else format('Lo marcó %s.', me.full_name) end,
        v_link, v_tag, false);
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

/** What the service did (support: «Se cambió el cable HDMI»), while the turn is open or after it ended. */
create or replace function public.note_turn_resolution(p_id bigint, p_text text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  r public.service_requests;
begin
  select * into r from public.service_requests x where x.id = p_id and x.school_id = me.school_id;
  if r.id is null or not private.serves(r.service_id) then raise exception 'No se encontró el turno.'; end if;
  update public.service_request_details set resolution = private.clean_text(p_text, 300, 'Lo que se hizo')
  where request_id = r.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Timers: support requests stay open until the service handles them
-- ---------------------------------------------------------------------------

/**
 * Every minute (pg_cron):
 *   * a called student nobody has sent yet: a reminder to whoever should send them, every 3 minutes, four times;
 *     then the service is told;
 *   * a student sent to a service who isn't there in time, or sent back who isn't in class in time: the service,
 *     the teacher (and on the way back, the group) and Seguridad are told.
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

  -- On the way back to class: the teacher who had the student, the other teachers of the group and the service.
  for r in
    select * from public.service_requests x
    where x.status = 'returning' and x.return_late_at is null and x.due_at < now()
    for update skip locked
  loop
    select * into s from public.school_services x where x.id = r.service_id;
    update public.service_requests set return_late_at = now() where id = r.id;
    v_who := format('%s (%s)', r.student_name, r.group_name);
    v_mins := greatest(1, round(extract(epoch from now() - r.returning_at) / 60)::int);
    v_since := format('Salió de %s hace %s min', s.name, v_mins);
    v_near := array_cat(array_append(private.service_staff_ids(s.id, null), r.teacher_id),
      private.group_teacher_ids(r.school_id, r.group_name, array[r.teacher_id]));
    a := null;
    if not exists (
      select 1 from public.student_alerts x
      where x.school_id = r.school_id and x.resolved_at is null
        and (x.turn_id = r.id or (r.student_id is not null and x.student_id = r.student_id))
    ) then
      insert into public.student_alerts (school_id, student_id, group_name, place, room, note, audience, created_by, created_by_name, turn_id)
      values (r.school_id, r.student_id, r.group_name, format('Regresaba de %s', s.name), r.room,
        'No se confirmó que llegó al salón.', 'security', r.teacher_id, s.name, r.id)
      returning * into a;
      perform private.notify_tagged(private.uuid_minus(private.perm_ids(r.school_id, 'security', null), v_near),
        format('🚨 No ha llegado al salón: %s', v_who),
        v_since || '. Si lo ves, toca «Apareció».',
        '#/alerts/missing/' || a.id, 'missing-' || a.id, true);
    end if;
    perform private.notify_tagged(v_near,
      format('⏱️ No ha llegado al salón: %s', v_who),
      v_since || case when a.id is not null then '. Se avisó a Seguridad.' else '.' end || ' Si ya llegó, toca «Llegó al salón».',
      '#/turns/' || r.id, 'turn-' || r.id, true);
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

-- ---------------------------------------------------------------------------
-- Panel and live board: where, who asked and what was done
-- ---------------------------------------------------------------------------

-- The panel's function gets more columns: the previous one is kept aside (private, unused) and a new one takes its
-- name.
alter function public.service_turns(bigint, timestamptz, timestamptz) rename to service_turns_before_support;
alter function public.service_turns_before_support(bigint, timestamptz, timestamptz) set schema private;
revoke execute on function private.service_turns_before_support(bigint, timestamptz, timestamptz) from public, anon, authenticated;

/**
 * A service's turns made between two moments, with the reason and what was done, never the teacher's note: for
 * whoever attends the service and whoever has "Datos y reportes". Ordered by id, so the app can read it in pages.
 */
create or replace function public.service_turns(p_service_id bigint, p_from timestamptz, p_to timestamptz)
returns table (
  id bigint, service_id bigint, student_name text, student_key text, group_name text, severity smallint,
  status text, outcome text, reason text, created_by_name text, handled_by_name text, out_of_order boolean,
  created_at timestamptz, called_at timestamptz, sent_at timestamptz, arrived_at timestamptz,
  on_the_way_at timestamptz, returning_at timestamptz, closed_at timestamptz, late_at timestamptz,
  room text, resolution text
)
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
begin
  if not exists (select 1 from public.school_services s where s.id = p_service_id and s.school_id = me.school_id) then
    raise exception 'No se encontró el servicio.';
  end if;
  if not (private.serves(p_service_id) or private.can(me, 'reports')) then
    raise exception 'Solo quien atiende este servicio y la dirección ven su panel.';
  end if;
  return query
    select r.id, r.service_id, r.student_name, r.student_key, r.group_name, r.severity, r.status, r.outcome, d.reason,
      r.created_by_name, r.handled_by_name, r.out_of_order, r.created_at, r.called_at, r.sent_at, r.arrived_at,
      r.on_the_way_at, r.returning_at, r.closed_at, r.late_at, r.room, d.resolution
    from public.service_requests r
    left join public.service_request_details d on d.request_id = r.id
    where r.service_id = p_service_id and r.created_at >= p_from and r.created_at < p_to
    order by r.id;
end;
$$;

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

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function
  public.service_turns(bigint, timestamptz, timestamptz),
  public.note_turn_resolution(bigint, text)
  from public, anon;
grant execute on function
  public.service_turns(bigint, timestamptz, timestamptz),
  public.note_turn_resolution(bigint, text)
  to authenticated;
