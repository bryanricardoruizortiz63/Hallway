-- Permissions under the Admin's control, by role and by person.
-- 1. What was fixed to Director(a) («the record of the turns with the students»: motive and outcome of every turn,
--    in the history, in the searches and in En vivo) is now a permission, «Ver el detalle de los turnos»
--    (turn_details), that the Admin gives or takes in Roles y permisos. Director(a) gets it so nothing changes today.
-- 2. Each person can have permissions besides those of their roles (perm_grants) or without some of them
--    (perm_denials). Only the Admin changes them, from the person's file, and the history records it.
--    What a person can do = (permissions of their roles ∪ given) − taken. The Admin can always do everything.

alter table public.school_roles drop constraint if exists school_roles_permissions_check;
alter table public.school_roles add constraint school_roles_permissions_check
  check (permissions <@ array['absences', 'register', 'staff', 'settings', 'services', 'messages', 'reports', 'live',
    'calendar', 'rooms', 'security', 'visitors', 'maintenance', 'summary', 'history',
    'absence_search', 'turn_search', 'own_absence_search', 'turn_details']::text[]);

update public.school_roles set permissions = permissions || array['turn_details']
where key = 'director' and not 'turn_details' = any(permissions);

alter table public.profiles add column if not exists perm_grants text[] not null default '{}';
alter table public.profiles add column if not exists perm_denials text[] not null default '{}';
alter table public.profiles drop constraint if exists profiles_perm_grants_check;
alter table public.profiles add constraint profiles_perm_grants_check
  check (perm_grants <@ array['absences', 'register', 'staff', 'settings', 'services', 'messages', 'reports', 'live',
    'calendar', 'rooms', 'security', 'visitors', 'maintenance', 'summary', 'history',
    'absence_search', 'turn_search', 'own_absence_search', 'turn_details']::text[]);
alter table public.profiles drop constraint if exists profiles_perm_denials_check;
alter table public.profiles add constraint profiles_perm_denials_check
  check (perm_denials <@ array['absences', 'register', 'staff', 'settings', 'services', 'messages', 'reports', 'live',
    'calendar', 'rooms', 'security', 'visitors', 'maintenance', 'summary', 'history',
    'absence_search', 'turn_search', 'own_absence_search', 'turn_details']::text[]);

-- New schools: Director(a) with the turns' detail, as before.
create or replace function private.add_default_roles(p_school uuid)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.school_roles (school_id, key, name, permissions, coverage, system, position) values
    (p_school, 'admin', 'Admin', array['absences', 'register', 'staff', 'settings', 'services', 'messages', 'reports', 'live', 'calendar', 'rooms', 'security', 'visitors', 'maintenance', 'summary'], false, true, 0),
    (p_school, 'director', 'Director(a)', array['absences', 'staff', 'settings', 'services', 'messages', 'reports', 'live', 'calendar', 'rooms', 'security', 'visitors', 'summary', 'turn_details'], true, false, 10),
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

-- ---- What a person can do ---------------------------------------------------------------------------------------

/**
 * The permissions of a person: those of their roles, plus what the Admin gave them, minus what the Admin took.
 * With p_no_admin, the Admin role's own list doesn't count (duties such as Mantenimiento or the daily summary are
 * not for the Admin account just because the Admin can do everything).
 */
create or replace function private.perms_of(p public.profiles, p_no_admin boolean default false)
returns text[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array(
    select distinct x from (
      select unnest(r.permissions) as x from public.school_roles r
      where r.school_id = p.school_id and r.key = any(private.roles_of(p)) and not (p_no_admin and r.key = 'admin')
      union all
      select unnest(p.perm_grants)
    ) s
    where x <> all (coalesce(p.perm_denials, '{}'))
    order by 1
  ), '{}')
$$;
revoke execute on function private.perms_of(public.profiles, boolean) from public, anon;
grant execute on function private.perms_of(public.profiles, boolean) to authenticated;

create or replace function private.can(me public.profiles, p_perm text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select me.id is not null and (private.is_admin(me) or p_perm = any(private.perms_of(me)))
$$;

/** The record of the turns with the students (their motive and outcome): Admin and whoever has turn_details. */
create or replace function private.history_full(p public.profiles)
returns boolean
language sql stable set search_path = ''
as $$
  select private.is_admin(p) or 'turn_details' = any(private.perms_of(p))
$$;

create or replace function private.perm_ids(p_school uuid, p_perm text, p_exclude uuid)
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(p.id), '{}') from public.profiles p
  where p.school_id = p_school and p.active and p_perm = any(private.perms_of(p)) and p.id is distinct from p_exclude
$$;

create or replace function private.staff_ids(p_school uuid, p_exclude uuid)
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select private.perm_ids(p_school, 'absences', p_exclude)
$$;

create or replace function private.manager_ids(p_school uuid, p_exclude uuid)
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select private.perm_ids(p_school, 'staff', p_exclude)
$$;

create or replace function private.maintenance_ids(p_school uuid, p_exclude uuid)
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(p.id), '{}') from public.profiles p
  where p.school_id = p_school and p.active and p.role <> 'admin' and 'maintenance' = any(private.perms_of(p, true))
    and p.id is distinct from p_exclude
$$;

create or replace function private.relief_ids(p_school uuid, p_exclude uuid)
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(p.id), '{}') from public.profiles p
  where p.school_id = p_school and p.active and p.id is distinct from p_exclude
    and ('absences' = any(private.perms_of(p))
      or exists (select 1 from public.school_roles r
                 where r.school_id = p.school_id and r.key = any(private.roles_of(p)) and r.coverage))
$$;

create or replace function private.in_relief_audience()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active
      and ('absences' = any(private.perms_of(p))
        or exists (select 1 from public.school_roles r
                   where r.school_id = p.school_id and r.key = any(private.roles_of(p)) and r.coverage))
  )
$$;

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
      select p.id from public.profiles p
      where p.school_id = s.id and p.active and p.role <> 'admin' and 'summary' = any(private.perms_of(p, true)));
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

-- Same as before, with the person's own permissions (and what was given or taken, for the Admin's screens).
create or replace function public.me()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'user', jsonb_build_object(
      'id', p.id, 'role', p.role, 'username', p.username, 'full_name', p.full_name, 'email', p.email,
      'phone', p.phone, 'position', p.position, 'employee_number', p.employee_number,
      'must_change_password', p.must_change_password, 'language', p.language, 'notify_off', to_jsonb(p.notify_off),
      'permissions', to_jsonb(private.perms_of(p)),
      'perm_grants', to_jsonb(p.perm_grants), 'perm_denials', to_jsonb(p.perm_denials),
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

-- Same as now, with what was given or taken to each person.
create or replace view public.employees_v with (security_invoker = true) as
select p.id, p.school_id, p.role, p.username, p.full_name, p.email, p.phone, p.employee_number, p."position",
  p.active, p.must_change_password, p.last_login_at, p.created_at, p.updated_at,
  (select count(*) from public.absences a
   where a.user_id = p.id and a.status <> 'cancelled' and a.category is distinct from 'actividad')::integer as absence_count,
  p.password_help_at, p.room, p.groups,
  p.require_mfa,
  private.has_mfa(p.id) as mfa_ready,
  p.extra_roles,
  p.app_version, p.app_version_at,
  p.perm_grants, p.perm_denials
from public.profiles p
where p.role <> 'admin';

-- ---- The Admin gives or takes permissions to a person ------------------------------------------------------------

/** A permission in words, as in «Roles y permisos». */
create or replace function private.perm_label(p_key text)
returns text
language sql immutable set search_path = ''
as $$
  select case p_key
    when 'absences' then 'Ver y confirmar las ausencias de todos'
    when 'register' then 'Registrar ausencias del personal'
    when 'staff' then 'Administrar el personal'
    when 'calendar' then 'Calendario escolar'
    when 'rooms' then 'Aprobar reservas del salón'
    when 'security' then 'Seguridad'
    when 'visitors' then 'Visitas'
    when 'maintenance' then 'Mantenimiento'
    when 'messages' then 'Enviar mensajes'
    when 'live' then 'En vivo'
    when 'reports' then 'Datos y reportes'
    when 'settings' then 'Configurar la escuela'
    when 'services' then 'Configurar Turnos'
    when 'history' then 'Historial del personal'
    when 'absence_search' then 'Buscar ausencias'
    when 'own_absence_search' then 'Buscar mis ausencias'
    when 'turn_search' then 'Buscar turnos'
    when 'summary' then 'Resumen del día'
    when 'turn_details' then 'Ver el detalle de los turnos'
    else p_key end
$$;

/**
 * The Admin gives (p_grants) or takes (p_denials) permissions to one person, besides those of their roles.
 * A permission can't be in both lists. Returns the person's permissions as they end up.
 */
create or replace function public.set_user_permissions(p_user uuid, p_grants text[], p_denials text[])
returns text[]
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_old public.profiles;
  v_new public.profiles;
  v_grants text[] := array(select distinct x from unnest(coalesce(p_grants, '{}')) x order by 1);
  v_denials text[] := array(select distinct x from unnest(coalesce(p_denials, '{}')) x order by 1);
  v_lines text[];
begin
  if not private.is_admin(me) then raise exception 'Solo el Admin puede dar o quitar permisos a una persona.'; end if;
  select * into v_old from public.profiles where id = p_user and school_id = me.school_id for update;
  if v_old.id is null then raise exception 'No se encontró a esa persona.'; end if;
  if private.is_admin(v_old) then raise exception 'El Admin ya puede hacerlo todo.'; end if;
  if v_grants && v_denials then raise exception 'Un permiso no puede estar dado y quitado a la vez.'; end if;

  update public.profiles set perm_grants = v_grants, perm_denials = v_denials, updated_at = now()
  where id = p_user returning * into v_new;

  -- «Le dio: …» · «Le quitó: …» · «Otra vez según su rol: …»
  v_lines := array_remove(array[
    'Le dio: ' || nullif(array_to_string(array(
      select private.perm_label(x) from unnest(v_grants) x where x <> all (v_old.perm_grants) order by 1), ', '), ''),
    'Le quitó: ' || nullif(array_to_string(array(
      select private.perm_label(x) from unnest(v_denials) x where x <> all (v_old.perm_denials) order by 1), ', '), ''),
    'Otra vez según su rol: ' || nullif(array_to_string(array(
      select private.perm_label(x) from unnest(v_old.perm_grants || v_old.perm_denials) x
      where x <> all (v_grants || v_denials) order by 1), ', '), '')
  ], null);
  if cardinality(v_lines) > 0 then
    perform private.log_activity(me.school_id, me.id, 'Cambió los permisos de ' || v_new.full_name,
      array_to_string(v_lines, ' · ') || ' · Ahora puede: '
        || coalesce(nullif(array_to_string(array(select private.perm_label(x) from unnest(private.perms_of(v_new)) x), ', '), ''), 'nada más que lo básico'),
      '#/employees/' || v_new.id, v_new.id);
  end if;
  return private.perms_of(v_new);
end;
$$;
revoke execute on function public.set_user_permissions(uuid, text[], text[]) from public, anon;
grant execute on function public.set_user_permissions(uuid, text[], text[]) to authenticated;
