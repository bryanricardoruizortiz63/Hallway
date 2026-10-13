-- Roles y permisos: three more things a role can do, each one its own checkbox.
--   * «Registrar ausencias del personal» (register): report an absence in someone else's name (e.g. when a teacher
--     calls the school) and modify or cancel anyone's absence, also one that already passed. Until now only the
--     Administración account could. It comes with «Ver y confirmar las ausencias de todos» (absences). Nobody gets
--     it but Administración: the school turns it on for the roles it wants.
--   * «Aprobar reservas del salón» (rooms): approve, reject and cancel the conference room reservations, with
--     priority for their own. It was part of «Calendario escolar» (calendar): every role that has calendar gets it,
--     so nothing changes until the school turns one of them off.
--   * «Configurar Turnos» (services): the services of Turnos (Enfermería, Trabajo Social, Soporte IT…), who attends
--     them, their reasons and times. It was part of «Configurar la escuela» (settings): every role that has
--     settings gets it.

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------

alter table public.school_roles drop constraint school_roles_permissions_check;
alter table public.school_roles add constraint school_roles_permissions_check
  check (permissions <@ array['absences', 'register', 'staff', 'settings', 'services', 'messages', 'reports', 'live', 'calendar', 'rooms', 'security', 'visitors', 'maintenance']::text[]);
-- Registering absences means seeing them, like managing the staff or the reports.
alter table public.school_roles drop constraint school_roles_permissions_check1;
alter table public.school_roles add constraint school_roles_permissions_check1
  check ('absences' = any(permissions) or not (permissions && array['staff', 'reports', 'register']));

-- What each role could do stays the same.
update public.school_roles set permissions = permissions || 'rooms'::text
where 'calendar' = any(permissions) and not 'rooms' = any(permissions);
update public.school_roles set permissions = permissions || 'services'::text
where 'settings' = any(permissions) and not 'services' = any(permissions);
update public.school_roles set permissions = permissions || 'register'::text
where key = 'admin' and not 'register' = any(permissions);

create or replace function private.add_default_roles(p_school uuid)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.school_roles (school_id, key, name, permissions, coverage, system, position) values
    (p_school, 'admin', 'Administración', array['absences', 'register', 'staff', 'settings', 'services', 'messages', 'reports', 'live', 'calendar', 'rooms', 'security', 'visitors', 'maintenance'], false, true, 0),
    (p_school, 'director', 'Director(a)', array['absences', 'staff', 'settings', 'services', 'messages', 'reports', 'live', 'calendar', 'rooms', 'security', 'visitors'], true, false, 10),
    (p_school, 'secretary', 'Secretaría', array['absences', 'live', 'calendar', 'rooms', 'security', 'visitors'], true, false, 20),
    (p_school, 'teacher', 'Maestro(a)', '{}', true, false, 30),
    (p_school, 'facultad', 'Facultad', '{}', true, false, 40),
    (p_school, 'enfermeria', 'Enfermería', '{}', false, false, 50),
    (p_school, 'trabajo_social', 'Trabajo Social', '{}', false, false, 55),
    (p_school, 'mantenimiento', 'Mantenimiento', array['maintenance'], false, false, 60),
    (p_school, 'it', 'Coordinador(a) de IT', '{}', false, false, 65),
    (p_school, 'seguridad', 'Seguridad', array['security', 'visitors'], false, false, 70)
  on conflict do nothing
$$;

-- ---------------------------------------------------------------------------
-- Registrar ausencias del personal
-- ---------------------------------------------------------------------------

create or replace function public.create_absence(
  p_start_date date,
  p_end_date date default null,
  p_partial boolean default false,
  p_start_time time default null,
  p_end_time time default null,
  p_category text default null,
  p_reason text default null,
  p_coverage_notes text default null,
  p_user_id uuid default null,
  p_today date default null,
  p_files jsonb default '[]'::jsonb
)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  emp public.profiles;
  v_today date := case when p_today between current_date - 1 and current_date + 1 then p_today else current_date end;
  v_partial boolean := coalesce(p_partial, false);
  v_end date;
  v_start_time time;
  v_end_time time;
  v_category text := nullif(btrim(p_category), '');
  v_id bigint;
  v_files int;
  v_summary text;
begin
  if p_user_id is not null and p_user_id <> me.id then
    if not private.can(me, 'register') then
      raise exception 'No tienes permiso para registrar ausencias de otros empleados.';
    end if;
    select * into emp from public.profiles
    where id = p_user_id and school_id = me.school_id and active and role <> 'admin';
    if emp.id is null then
      raise exception 'El empleado seleccionado no existe o está inactivo.';
    end if;
  else
    if me.role = 'admin' then
      raise exception 'Selecciona el empleado que va a faltar.';
    end if;
    emp := me;
  end if;

  if p_start_date is null then
    raise exception 'Selecciona una fecha válida.';
  end if;
  v_end := case when v_partial then p_start_date else coalesce(p_end_date, p_start_date) end;
  if v_end < p_start_date then
    raise exception 'La fecha final no puede ser antes de la fecha inicial.';
  end if;
  if v_end - p_start_date > 90 then
    raise exception 'Una ausencia no puede durar más de 90 días.';
  end if;
  if v_today - p_start_date > 60 then
    raise exception 'La fecha es demasiado antigua (máx. 60 días atrás).';
  end if;
  if p_start_date - v_today > 365 then
    raise exception 'La fecha es demasiado lejana.';
  end if;

  if v_partial then
    if p_start_time is null then
      raise exception 'Indica la hora de inicio de la ausencia.';
    end if;
    v_start_time := p_start_time;
    if p_end_time is not null then
      if p_end_time <= p_start_time then
        raise exception 'La hora final debe ser después de la hora de inicio.';
      end if;
      v_end_time := p_end_time;
    end if;
  end if;

  if v_category is not null and private.category_label(v_category) is null then
    raise exception 'Tipo de ausencia no válido.';
  end if;

  insert into public.absences (
    school_id, user_id, created_by, created_by_name, start_date, end_date, partial, start_time, end_time,
    category, reason, coverage_notes
  )
  values (
    me.school_id, emp.id, me.id, me.full_name, p_start_date, v_end, v_partial, v_start_time, v_end_time,
    v_category, private.clean_text(p_reason, 1000, 'La causa'),
    private.clean_text(p_coverage_notes, 1000, 'Las notas para cubrir')
  )
  returning id into v_id;

  v_files := private.insert_attachments(v_id, me, p_files);

  v_summary := private.fmt_range(p_start_date, v_end) || ' · ' || private.fmt_schedule(v_partial, v_start_time, v_end_time)
    || coalesce(' · ' || private.category_label(v_category), '');
  perform private.notify(
    private.staff_ids(me.school_id, me.id),
    'Nueva ausencia: ' || emp.full_name, v_summary, '#/absence/' || v_id
  );
  if emp.id <> me.id then
    perform private.notify(
      array[emp.id], 'Se registró una ausencia a tu nombre',
      me.full_name || ' registró tu ausencia para ' || private.fmt_range(p_start_date, v_end) || '.',
      '#/absence/' || v_id
    );
  end if;
  insert into public.outbox (kind, school_id, payload)
  values ('teams', me.school_id, jsonb_build_object('event', 'created', 'absence_id', v_id));

  return v_id;
end;
$$;

/** Whoever registers the absences of the staff (and the Administración account) can always; the employee, until it passes. */
create or replace function private.require_owner_or_admin(a public.absences, me public.profiles, p_action text)
returns void
language plpgsql stable set search_path = ''
as $$
begin
  if private.can(me, 'register') then
    return;
  end if;
  if a.user_id <> me.id then
    raise exception 'Solo el empleado o quien registra las ausencias del personal pueden % esta ausencia.', p_action;
  end if;
  -- One day of margin for time zones; the app itself uses the phone's date.
  if a.end_date < current_date - 1 then
    raise exception 'Esta ausencia ya pasó. Pide a quien registra las ausencias del personal que la corrija.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Aprobar reservas del salón
-- ---------------------------------------------------------------------------

/**
 * Reserves the room. Secretaría and the dirección get it approved at once; over someone else's reservation
 * (approved or waiting) they must say p_replace = true, and that reservation is replaced.
 * p_note: an optional note for whoever approves; it starts the reservation's notes.
 */
create or replace function public.create_room_booking(
  p_day date, p_start time, p_end time, p_purpose text, p_replace boolean default false, p_note text default null
)
returns public.room_bookings
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_priority boolean := private.can(me, 'rooms');
  v_purpose text := private.clean_text(regexp_replace(coalesce(p_purpose, ''), '\s+', ' ', 'g'), 120, 'Para qué es');
  v_note text := private.clean_text(p_note, 1000, 'La nota');
  b public.room_bookings;
  x public.room_bookings;
  v_replaced bigint[];
begin
  if v_purpose is null then raise exception 'Escribe para qué es (por ejemplo, «Reunión de padres de 9-B»).'; end if;
  -- One day of margin for time zones; the app checks the hour with the phone's clock.
  if p_day < current_date - 1 then raise exception 'Esa fecha ya pasó.'; end if;
  if p_day > current_date + 365 then raise exception 'Se puede reservar hasta con un año de anticipación.'; end if;
  perform private.check_room_time(me.school_id, p_day, p_start, p_end);
  if (select count(*) from public.room_bookings r where r.created_by = me.id and r.created_at > now() - interval '1 hour') >= 20 then
    raise exception 'Hiciste muchas reservas en la última hora. Espera un poco.';
  end if;

  -- One at a time per school, so two people can't take the same time.
  perform pg_advisory_xact_lock(hashtextextended('room_bookings:' || me.school_id::text, 0));

  if exists (
    select 1 from public.room_bookings r
    where r.school_id = me.school_id and r.day = p_day and r.created_by = me.id and r.status in ('pending', 'approved')
      and r.start_time < p_end and r.end_time > p_start
  ) then
    raise exception 'Ya tienes una reserva a esa hora.';
  end if;

  -- Approved reservations that can't be replaced: anyone else's for teachers, Secretaría's or the dirección's for them.
  select * into x from public.room_bookings r
  where r.school_id = me.school_id and r.day = p_day and r.status = 'approved'
    and r.start_time < p_end and r.end_time > p_start and (r.priority or not v_priority)
  order by r.start_time limit 1;
  if x.id is not null then
    raise exception 'Ya está reservado de % a % por %.%', private.time_text(x.start_time), private.time_text(x.end_time),
      x.created_by_name, private.room_free_sentence(me.school_id, p_day);
  end if;

  if v_priority then
    select * into x from public.room_bookings r
    where r.school_id = me.school_id and r.day = p_day and r.status in ('pending', 'approved')
      and r.start_time < p_end and r.end_time > p_start
    order by r.start_time limit 1;
    if x.id is not null and not coalesce(p_replace, false) then
      raise exception 'Ya % de % a % (%). ¿Quieres reemplazarla?',
        case x.status when 'approved' then 'lo reservó ' else 'lo pidió ' end || x.created_by_name,
        private.time_text(x.start_time), private.time_text(x.end_time), x.purpose;
    end if;
    -- First out of the way (approved reservations can't overlap), then the new one.
    with gone as (
      update public.room_bookings r
      set status = 'replaced', closed_at = now(), closed_by_name = me.full_name
      where r.school_id = me.school_id and r.day = p_day and r.status in ('pending', 'approved')
        and r.start_time < p_end and r.end_time > p_start
      returning r.id
    )
    select coalesce(array_agg(id), '{}') into v_replaced from gone;
  end if;

  insert into public.room_bookings (school_id, day, start_time, end_time, purpose, status, priority,
    created_by, created_by_name, approved_at, approved_by_name)
  values (me.school_id, p_day, p_start, p_end, v_purpose,
    case when v_priority then 'approved' else 'pending' end, v_priority, me.id, me.full_name,
    case when v_priority then now() end, case when v_priority then me.full_name end)
  returning * into b;
  if v_note is not null then
    insert into public.room_booking_notes (booking_id, school_id, user_id, author_name, author_role, body)
    values (b.id, me.school_id, me.id, me.full_name, me.role, v_note);
  end if;

  if cardinality(v_replaced) > 0 then
    update public.room_bookings set replaced_by = b.id where id = any(v_replaced);
    for x in select * from public.room_bookings r where r.id = any(v_replaced) loop
      perform private.close_notifications('#/rooms/' || x.id);
      perform private.notify_tagged(array[x.created_by]::uuid[],
        '📅 Tu reserva del salón se reemplazó',
        format('%s necesita el salón de conferencias: %s (%s). Tu reserva era «%s», de %s a %s%s', me.full_name,
          private.room_when(p_day, p_start, p_end), v_purpose, x.purpose, private.time_text(x.start_time),
          private.time_text(x.end_time), private.room_free_sentence(me.school_id, p_day)),
        '#/rooms/' || x.id, 'room-' || x.id, false);
    end loop;
  end if;

  if not v_priority then
    perform private.notify_tagged(private.perm_ids(me.school_id, 'rooms', me.id),
      '📅 Reserva del salón por aprobar',
      format('%s · %s · %s.', me.full_name, private.room_when(p_day, p_start, p_end), v_purpose)
        || case when v_note is not null then format(' Nota: «%s»', private.short_text(v_note, 120)) else '' end,
      '#/rooms/' || b.id, 'room-' || b.id, false);
  end if;
  return b;
end;
$$;

/** Whoever reserved it, or Secretaría / the dirección (p_note: why), cancels a waiting or approved reservation. */
create or replace function public.cancel_room_booking(p_id bigint, p_note text default null)
returns public.room_bookings
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_note text := private.clean_text(p_note, 300, 'El motivo');
  v_manager boolean := private.can(me, 'rooms');
  b public.room_bookings;
begin
  select * into b from public.room_bookings r where r.id = p_id and r.school_id = me.school_id for update;
  if b.id is null or not (b.created_by = me.id or v_manager) then raise exception 'No se encontró la reserva.'; end if;
  if b.status not in ('pending', 'approved') then raise exception 'Esta reserva ya no está activa.'; end if;
  if b.day < current_date - 1 then raise exception 'Esa reserva ya pasó.'; end if;
  update public.room_bookings set status = 'cancelled', closed_at = now(), closed_by_name = me.full_name, close_note = v_note
  where id = b.id returning * into b;
  perform private.close_notifications('#/rooms/' || b.id);
  if b.created_by is distinct from me.id then
    perform private.notify_tagged(array[b.created_by]::uuid[],
      '📅 Reserva del salón cancelada',
      format('%s · %s. La canceló %s%s.', private.room_when(b.day, b.start_time, b.end_time), b.purpose, me.full_name,
        coalesce(': ' || rtrim(v_note, '.'), '')),
      '#/rooms/' || b.id, 'room-' || b.id, false);
  end if;
  return b;
end;
$$;

/** Secretaría or the dirección approve or reject a request (p_note: why not). */
create or replace function public.decide_room_booking(p_id bigint, p_approve boolean, p_note text default null)
returns public.room_bookings
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_note text := private.clean_text(p_note, 300, 'El motivo');
  b public.room_bookings;
  x public.room_bookings;
begin
  if not private.can(me, 'rooms') then raise exception 'No tienes permiso para aprobar las reservas del salón.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('room_bookings:' || me.school_id::text, 0));
  select * into b from public.room_bookings r where r.id = p_id and r.school_id = me.school_id for update;
  if b.id is null then raise exception 'No se encontró la reserva.'; end if;
  if b.status <> 'pending' then raise exception 'Esta reserva ya no está esperando respuesta.'; end if;

  if coalesce(p_approve, false) then
    if b.day < current_date - 1 then raise exception 'Esa fecha ya pasó.'; end if;
    perform private.check_room_time(me.school_id, b.day, b.start_time, b.end_time);
    select * into x from public.room_bookings r
    where r.school_id = me.school_id and r.day = b.day and r.status = 'approved'
      and r.start_time < b.end_time and r.end_time > b.start_time
    order by r.start_time limit 1;
    if x.id is not null then
      raise exception 'Choca con la reserva de % (% a %). Recházala o cancela la otra primero.',
        x.created_by_name, private.time_text(x.start_time), private.time_text(x.end_time);
    end if;
    update public.room_bookings set status = 'approved', approved_at = now(), approved_by_name = me.full_name
    where id = b.id returning * into b;
    perform private.close_notifications('#/rooms/' || b.id);
    perform private.notify_tagged(array_remove(array[b.created_by], me.id),
      '✅ Reserva del salón aprobada',
      format('%s · %s. La aprobó %s.', private.room_when(b.day, b.start_time, b.end_time), b.purpose, me.full_name),
      '#/rooms/' || b.id, 'room-' || b.id, false);
    -- The other requests for that time can't be approved any more.
    for x in
      update public.room_bookings r
      set status = 'rejected', closed_at = now(), closed_by_name = me.full_name, close_note = 'Se aprobó otra reserva a esa hora.'
      where r.school_id = me.school_id and r.day = b.day and r.status = 'pending' and r.id <> b.id
        and r.start_time < b.end_time and r.end_time > b.start_time
      returning r.*
    loop
      perform private.close_notifications('#/rooms/' || x.id);
      perform private.notify_tagged(array_remove(array[x.created_by], me.id),
        '📅 Reserva del salón no aprobada',
        format('%s · %s. Se aprobó otra reserva a esa hora.%s', private.room_when(x.day, x.start_time, x.end_time),
          x.purpose, private.room_free_sentence(me.school_id, x.day)),
        '#/rooms/' || x.id, 'room-' || x.id, false);
    end loop;
  else
    update public.room_bookings set status = 'rejected', closed_at = now(), closed_by_name = me.full_name, close_note = v_note
    where id = b.id returning * into b;
    perform private.close_notifications('#/rooms/' || b.id);
    perform private.notify_tagged(array_remove(array[b.created_by], me.id),
      '📅 Reserva del salón no aprobada',
      format('%s · %s. No la aprobó %s%s.%s', private.room_when(b.day, b.start_time, b.end_time), b.purpose,
        me.full_name, coalesce(': ' || rtrim(v_note, '.'), ''), private.room_free_sentence(me.school_id, b.day)),
      '#/rooms/' || b.id, 'room-' || b.id, false);
  end if;
  return b;
end;
$$;

/** A note on a reservation, by whoever asked for it or by Secretaría / the dirección. */
create or replace function public.add_room_booking_note(p_id bigint, p_body text)
returns public.room_booking_notes
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  b public.room_bookings;
  n public.room_booking_notes;
  v_body text := private.clean_text(p_body, 1000, 'La nota');
begin
  select * into b from public.room_bookings x where x.id = p_id and x.school_id = me.school_id;
  if b.id is null or not (b.created_by = me.id or private.can(me, 'rooms')) then
    raise exception 'No se encontró la reserva.';
  end if;
  if v_body is null then raise exception 'Escribe la nota.'; end if;
  if (select count(*) from public.room_booking_notes x where x.user_id = me.id and x.created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Escribiste muchas notas en la última hora. Espera un poco.';
  end if;
  insert into public.room_booking_notes (booking_id, school_id, user_id, author_name, author_role, body)
  values (b.id, me.school_id, me.id, me.full_name, me.role, v_body)
  returning * into n;
  -- The others in the conversation: whoever asked, and Secretaría / the dirección.
  perform private.notify_tagged(
    private.uuid_minus(array_append(private.perm_ids(me.school_id, 'rooms', me.id), b.created_by), array[me.id]),
    '💬 Nota sobre la reserva del salón',
    format('%s: %s · %s (%s)', me.full_name, private.short_text(v_body, 120),
      private.room_when(b.day, b.start_time, b.end_time), b.purpose),
    '#/rooms/' || b.id, 'room-' || b.id, false);
  return n;
end;
$$;

alter policy "Ver reservas del salón" on public.room_bookings
  using (school_id = (select private.my_school_id())
    and (status in ('pending', 'approved') or created_by = (select auth.uid()) or (select private.has_perm('rooms'))));

alter policy "Ver notas de reservas del salón" on public.room_booking_notes
  using (school_id = (select private.my_school_id())
    and ((select private.has_perm('rooms'))
      or exists (select 1 from public.room_bookings b
                 where b.id = room_booking_notes.booking_id and b.created_by = (select auth.uid()))));

-- ---------------------------------------------------------------------------
-- Configurar Turnos
-- ---------------------------------------------------------------------------

/**
 * The services (inactive ones only for whoever sets them up): whether I attend each one, how many turns are
 * waiting, and who is available.
 */
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
        'serves', me.role = any(s.roles),
        'waiting', (select count(*) from public.service_requests x where x.service_id = s.id and x.status = 'waiting'),
        'staff', (
          select coalesce(jsonb_agg(jsonb_build_object(
              'id', p.id, 'name', p.full_name, 'status', private.staff_status(st),
              'until', case when private.staff_status(st) <> 'available' then st.until end)
            order by p.full_name), '[]'::jsonb)
          from public.profiles p
          left join public.service_staff_status st on st.user_id = p.id
          where p.school_id = s.school_id and p.active and p.role = any(s.roles))
      ) order by s.position, s.name)
    from public.school_services s
    where s.school_id = me.school_id and (s.active or private.can(me, 'services'))
  ), '[]'::jsonb);
end;
$$;

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
  if not private.can(me, 'services') then raise exception 'No tienes permiso para cambiar los servicios.'; end if;
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
