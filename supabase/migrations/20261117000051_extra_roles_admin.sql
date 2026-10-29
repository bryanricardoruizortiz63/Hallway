-- «Admin» como un rol más, y varios roles por persona.
--   * La cuenta «admin» de cada escuela se sigue llamando así por dentro, pero el rol se ve como «Admin» (antes
--     «Administración»).
--   * profiles.extra_roles: otros roles de la persona además del suyo (el de role). Así la directora o el coordinador
--     de IT pueden ser también Admin, o alguien puede ser Secretaría y Enfermería a la vez. Puede hacer todo lo que
--     puede cualquiera de sus roles, atiende los servicios de cualquiera de ellos y, con Admin, puede hacer todo en su
--     escuela (como la cuenta admin). Si cubren sus ausencias y si reporta las suyas lo sigue diciendo su rol principal.
--   * La cuenta admin sigue siendo una sola por escuela y la plataforma le reinicia la contraseña.

alter table public.profiles add column extra_roles text[] not null default '{}';

/** Every role of this person: the main one and the others. */
create or replace function private.roles_of(p public.profiles)
returns text[]
language sql immutable set search_path = ''
as $$
  select array[p.role] || coalesce(p.extra_roles, '{}')
$$;

/** The school's admin account, or someone who also has the Admin role: can do everything in their school. */
create or replace function private.is_admin(p public.profiles)
returns boolean
language sql immutable set search_path = ''
as $$
  select p.id is not null and 'admin' = any(private.roles_of(p))
$$;

-- Same as in 20261007000008, with every role of the person.
create or replace function private.can(me public.profiles, p_perm text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select me.id is not null and (
    private.is_admin(me)
    or exists (
      select 1 from public.school_roles r
      where r.school_id = me.school_id and r.key = any(private.roles_of(me)) and p_perm = any(r.permissions)
    )
  )
$$;

/** Other roles: roles of the same school, without repeating the main one; the admin account has none. */
create or replace function private.check_extra_roles()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.extra_roles := coalesce((
    select array_agg(distinct x) from unnest(new.extra_roles) as x where x is distinct from new.role
  ), '{}');
  if new.role = 'admin' then new.extra_roles := '{}'; end if;
  if exists (
    select 1 from unnest(new.extra_roles) as x
    where not exists (select 1 from public.school_roles r where r.school_id = new.school_id and r.key = x)
  ) then
    raise exception 'Uno de los otros roles no existe en esta escuela.';
  end if;
  return new;
end;
$$;

create trigger profiles_extra_roles before insert or update of extra_roles, role on public.profiles
for each row execute function private.check_extra_roles();

grant execute on function private.roles_of(public.profiles), private.is_admin(public.profiles) to authenticated;

update public.school_roles set name = 'Admin' where key = 'admin' and name = 'Administración';

-- Same as in 20261030000033, with the Admin name.
create or replace function private.add_default_roles(p_school uuid)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.school_roles (school_id, key, name, permissions, coverage, system, position) values
    (p_school, 'admin', 'Admin', array['absences', 'register', 'staff', 'settings', 'services', 'messages', 'reports', 'live', 'calendar', 'rooms', 'security', 'visitors', 'maintenance', 'summary'], false, true, 0),
    (p_school, 'director', 'Director(a)', array['absences', 'staff', 'settings', 'services', 'messages', 'reports', 'live', 'calendar', 'rooms', 'security', 'visitors', 'summary'], true, false, 10),
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

-- Same as in 20261111000045, with the other roles.
create or replace view public.employees_v with (security_invoker = true) as
select p.id, p.school_id, p.role, p.username, p.full_name, p.email, p.phone, p.employee_number, p."position",
  p.active, p.must_change_password, p.last_login_at, p.created_at, p.updated_at,
  (select count(*) from public.absences a where a.user_id = p.id and a.status <> 'cancelled')::integer as absence_count,
  p.password_help_at, p.room, p.groups,
  p.require_mfa,
  private.has_mfa(p.id) as mfa_ready,
  p.extra_roles
from public.profiles p
where p.role <> 'admin';

-- Same as in 20261115000049, with the other roles: the permissions of all of them, and their services.
create or replace function public.me()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'user', jsonb_build_object(
      'id', p.id, 'role', p.role, 'username', p.username, 'full_name', p.full_name, 'email', p.email,
      'phone', p.phone, 'position', p.position, 'employee_number', p.employee_number,
      'must_change_password', p.must_change_password,
      'permissions', coalesce((
        select jsonb_agg(distinct x.perm order by x.perm)
        from public.school_roles rr, unnest(rr.permissions) as x(perm)
        where rr.school_id = p.school_id and rr.key = any(private.roles_of(p))
      ), '[]'::jsonb),
      'extra_roles', to_jsonb(p.extra_roles),
      'coverage', coalesce(r.coverage and p.role <> 'admin', false),
      'own_absences', coalesce(r.own_absences, true) and p.role <> 'admin',
      'room', p.room, 'groups', to_jsonb(p.groups),
      'serves', coalesce((
        select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name) order by x.position, x.name)
        from public.school_services x
        where x.school_id = p.school_id and x.active and private.roles_of(p) && x.roles
      ), '[]'::jsonb)
    ),
    'school', jsonb_build_object(
      'id', s.id, 'code', s.code, 'name', s.name, 'icon_version', s.icon_version,
      'calendar', private.calendar_json(s.id),
      'disabled_modules', to_jsonb(s.disabled_modules)
    ),
    'roles', coalesce((
      select jsonb_agg(jsonb_build_object('key', x.key, 'name', x.name, 'permissions', x.permissions, 'coverage', x.coverage,
        'own_absences', x.own_absences)
        order by x.position, x.name)
      from public.school_roles x where x.school_id = s.id and not x.system
    ), '[]'::jsonb)
  )
  from public.profiles p
  join public.schools s on s.id = p.school_id
  left join public.school_roles r on r.school_id = p.school_id and r.key = p.role
  where p.id = auth.uid() and p.active and s.active
$$;

-- Same as in 20261010000013_service_turns, with every role of the person.
create or replace function private.serves(p_service_id bigint)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.school_services s
    join public.profiles p on p.school_id = s.school_id
    where s.id = p_service_id and p.id = auth.uid() and p.active and private.roles_of(p) && s.roles
  )
$$;

-- Same as in 20261010000013_service_turns, with every role of the person.
create or replace function private.service_staff_ids(p_service_id bigint, p_exclude uuid)
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(p.id), '{}') from public.school_services s
  join public.profiles p on p.school_id = s.school_id
  where s.id = p_service_id and p.active and private.roles_of(p) && s.roles and p.id is distinct from p_exclude
$$;

-- Same as in 20261022000025_visits, with every role of the person.
create or replace function private.visit_is_for(v public.visits, me public.profiles)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(v.target_id = me.id, false) or (v.service_id is not null and exists (
    select 1 from public.school_services s where s.id = v.service_id and private.roles_of(me) && s.roles))
$$;

-- Same as in 20261106000040_return_check, with every role of the person.
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

-- Same as in 20261028000031_live_board_more, with every role of the person.
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
            where p.school_id = s.school_id and p.active and private.roles_of(p) && s.roles),
          'active', (
            select coalesce(jsonb_agg(jsonb_build_object(
                'id', r.id, 'student', r.student_name, 'group', r.group_name, 'status', r.status,
                'room', r.room, 'created_by_name', r.created_by_name,
                'reason', (select d.reason from public.service_request_details d where d.request_id = r.id),
                'level', case when r.status = 'waiting' then private.turn_level(r.severity, r.created_at) else r.severity end,
                'since', coalesce(r.returning_at, r.arrived_at, r.on_the_way_at, r.sent_at, r.called_at, r.created_at),
                'late', r.late_at is not null and r.arrived_at is null,
                'out_since', case when r.status in ('sent', 'arrived', 'returning')
                  then coalesce(r.sent_at, r.arrived_at, r.returning_at) end,
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

-- Same as in 20261109000043_support_received, with every role of the person.
create or replace function public.receive_support_request(p_id bigint)
returns public.service_requests
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  r public.service_requests;
  s public.school_services;
  v_what text;
  v_position int;
begin
  select * into r from public.service_requests x where x.id = p_id and x.school_id = me.school_id for update;
  if r.id is null then raise exception 'No se encontró el pedido.'; end if;
  select * into s from public.school_services x where x.id = r.service_id;
  if s.mode <> 'support' or not (private.roles_of(me) && s.roles) then raise exception 'Lo marca %.', s.name; end if;
  if r.status <> 'waiting' then raise exception 'Este pedido ya no está en espera.'; end if;
  if r.received_at is not null then
    raise exception 'Ya lo marcó %.', coalesce(r.received_by_name, 'otra persona');
  end if;
  update public.service_requests set received_at = now(), received_by_name = me.full_name
  where id = r.id returning * into r;
  v_position := private.turn_position(r.id);
  v_what := coalesce((select d.reason from public.service_request_details d where d.request_id = r.id), 'tu pedido');
  -- The urgent notice stops ringing for the service.
  perform private.close_notifications('#/turns/' || r.id);
  perform private.notify_tagged(array_remove(array[r.created_by], me.id),
    format('📋 %s recibió tu pedido', s.name),
    concat_ws(' · ', v_what || coalesce(' (' || r.room || ')', ''), 'lo recibió ' || me.full_name,
      case when v_position is not null then format('vas #%s en la fila', v_position) end) || '.',
    '#/turns/' || r.id, 'turn-' || r.id, false);
  return r;
end;
$$;

-- Same as in 20261105000039_turn_notice_urgent, with every role of the person.
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

-- Same as in 20261025000028_role_options, with every role of the person.
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
              'until', case when private.staff_status(st) <> 'available' then st.until end)
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

-- Same as in 20261010000013_service_turns, with every role of the person.
create or replace function public.set_my_service_status(p_status text, p_until timestamptz default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_until timestamptz := case when p_status = 'available' then null else p_until end;
begin
  if not exists (select 1 from public.school_services s where s.school_id = me.school_id and private.roles_of(me) && s.roles) then
    raise exception 'Tu rol no atiende ningún servicio.';
  end if;
  if p_status is null or p_status not in ('available', 'meeting', 'lunch', 'away') then raise exception 'Estado no válido.'; end if;
  if p_status = 'away' and v_until is null then raise exception 'Elige hasta qué hora estarás fuera.'; end if;
  if v_until is not null and (v_until <= now() or v_until > now() + interval '12 hours') then
    raise exception 'Elige una hora de hoy, más tarde que ahora.';
  end if;
  insert into public.service_staff_status (user_id, school_id, status, until, updated_at)
  values (me.id, me.school_id, p_status, v_until, now())
  on conflict (user_id) do update
    set school_id = excluded.school_id, status = excluded.status, until = excluded.until, updated_at = excluded.updated_at;
  return jsonb_build_object('status', p_status, 'until', v_until);
end;
$$;

-- Same as in 20261022000025_visits, with every role of the person.
create or replace function public.visit_targets()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
begin
  if not private.can(me, 'visitors') then raise exception 'No tienes permiso para avisar visitas.'; end if;
  return jsonb_build_object(
    'services', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', s.id, 'name', s.name,
          'staff', (
            select coalesce(jsonb_agg(jsonb_build_object(
                'name', p.full_name, 'status', private.staff_status(st),
                'until', case when private.staff_status(st) <> 'available' then st.until end)
              order by p.full_name), '[]'::jsonb)
            from public.profiles p
            left join public.service_staff_status st on st.user_id = p.id
            where p.school_id = s.school_id and p.active and private.roles_of(p) && s.roles))
        order by s.position, s.name)
      from public.school_services s
      where s.school_id = me.school_id and s.active
    ), '[]'::jsonb),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', p.id, 'name', p.full_name, 'position', p.position, 'room', p.room,
          'role', (select r.name from public.school_roles r where r.school_id = p.school_id and r.key = p.role))
        order by p.full_name)
      from public.profiles p
      where p.school_id = me.school_id and p.active and p.role <> 'admin' and p.id <> me.id
    ), '[]'::jsonb)
  );
end;
$$;


-- Same as in 20261009000012_students_and_alerts, with every role of the person.
create or replace function private.in_relief_audience()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    join public.school_roles r on r.school_id = p.school_id and r.key = any(private.roles_of(p))
    where p.id = auth.uid() and p.active and (r.coverage or 'absences' = any(r.permissions))
  )
$$;

-- Same as in 20261011000014_maintenance, with every role of the person.
create or replace function private.maintenance_ids(p_school uuid, p_exclude uuid)
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(distinct p.id), '{}') from public.profiles p
  join public.school_roles r on r.school_id = p.school_id and r.key = any(private.roles_of(p)) and r.key <> 'admin'
  where p.school_id = p_school and p.active and p.role <> 'admin' and 'maintenance' = any(r.permissions)
    and p.id is distinct from p_exclude
$$;

-- Same as in 20261007000008_roles_and_permissions, with every role of the person.
create or replace function private.manager_ids(p_school uuid, p_exclude uuid)
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(distinct p.id), '{}') from public.profiles p
  join public.school_roles r on r.school_id = p.school_id and r.key = any(private.roles_of(p))
  where p.school_id = p_school and p.active and 'staff' = any(r.permissions)
    and p.id is distinct from p_exclude
$$;

-- Same as in 20261009000012_students_and_alerts, with every role of the person.
create or replace function private.perm_ids(p_school uuid, p_perm text, p_exclude uuid)
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(distinct p.id), '{}') from public.profiles p
  join public.school_roles r on r.school_id = p.school_id and r.key = any(private.roles_of(p))
  where p.school_id = p_school and p.active and p_perm = any(r.permissions) and p.id is distinct from p_exclude
$$;

-- Same as in 20261009000012_students_and_alerts, with every role of the person.
create or replace function private.relief_ids(p_school uuid, p_exclude uuid)
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(distinct p.id), '{}') from public.profiles p
  join public.school_roles r on r.school_id = p.school_id and r.key = any(private.roles_of(p))
  where p.school_id = p_school and p.active and (r.coverage or 'absences' = any(r.permissions))
    and p.id is distinct from p_exclude
$$;

-- Same as in 20261007000008_roles_and_permissions, with every role of the person.
create or replace function private.staff_ids(p_school uuid, p_exclude uuid)
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(distinct p.id), '{}') from public.profiles p
  join public.school_roles r on r.school_id = p.school_id and r.key = any(private.roles_of(p))
  where p.school_id = p_school and p.active and 'absences' = any(r.permissions)
    and p.id is distinct from p_exclude
$$;

-- Same as in 20261030000033_daily_summary, with every role of the person.
create or replace function private.send_daily_summaries()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  s record;
  v_local timestamp;
  v_day date;
  v_to uuid[];
  v_sum jsonb;
begin
  for s in
    select x.id, coalesce(st.time_zone, 'America/Puerto_Rico') as tz, coalesce(st.day_end, '15:30'::time) as day_end,
      coalesce(st.school_days, '{1,2,3,4,5}'::smallint[]) as school_days
    from public.schools x
    left join public.school_settings st on st.school_id = x.id
  loop
    v_local := now() at time zone s.tz;
    v_day := v_local::date;
    continue when not extract(isodow from v_day)::smallint = any(s.school_days)
      or v_local < v_day + s.day_end or v_local >= v_day + s.day_end + interval '3 hours'
      or exists (select 1 from public.school_closures c where c.school_id = s.id and v_day between c.start_date and c.end_date);
    v_to := array(
      select distinct p.id from public.profiles p
      join public.school_roles r on r.school_id = p.school_id and r.key = any(private.roles_of(p)) and r.key <> 'admin'
      where p.school_id = s.id and p.active and p.role <> 'admin' and 'summary' = any(r.permissions));
    continue when cardinality(v_to) = 0;
    insert into public.daily_summaries (school_id, day) values (s.id, v_day) on conflict do nothing;
    continue when not found;
    v_sum := private.summary_of(s.id, v_day);
    perform private.notify_tagged(
      v_to, '📊 Resumen del día · ' || private.fmt_date(v_day), private.summary_text(v_sum),
      '#/summary/' || to_char(v_day, 'YYYY-MM-DD'), 'summary-' || to_char(v_day, 'YYYY-MM-DD'), false);
  end loop;
end;
$$;

