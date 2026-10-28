-- Panel de plataforma, etapa 1: uso por escuela y módulos por escuela.
--   * schools.disabled_modules: lo que la plataforma apaga en una escuela (turns = Enfermería y Trabajo Social,
--     support = Soporte IT, alerts, maintenance, rooms = Reservas del salón, visits, live = En vivo). La app esconde
--     esas pestañas, enlaces y servicios; me() los devuelve en school.disabled_modules.
--   * platform_schools(): además, cuánta gente entró este mes, turnos, alertas, mantenimiento y reservas del mes,
--     el último inicio de sesión y el espacio de archivos de la escuela.

alter table public.schools add column disabled_modules text[] not null default '{}'
  check (disabled_modules <@ array['turns', 'support', 'alerts', 'maintenance', 'rooms', 'visits', 'live']);

-- Same as before, with school.disabled_modules.
create or replace function public.me()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'user', jsonb_build_object(
      'id', p.id, 'role', p.role, 'username', p.username, 'full_name', p.full_name, 'email', p.email,
      'phone', p.phone, 'position', p.position, 'employee_number', p.employee_number,
      'must_change_password', p.must_change_password,
      'permissions', coalesce(to_jsonb(r.permissions), '[]'::jsonb),
      'coverage', coalesce(r.coverage and p.role <> 'admin', false),
      'room', p.room, 'groups', to_jsonb(p.groups),
      'serves', coalesce((
        select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name) order by x.position, x.name)
        from public.school_services x
        where x.school_id = p.school_id and x.active and p.role = any(x.roles)
      ), '[]'::jsonb)
    ),
    'school', jsonb_build_object(
      'id', s.id, 'code', s.code, 'name', s.name, 'icon_version', s.icon_version,
      'calendar', private.calendar_json(s.id),
      'disabled_modules', to_jsonb(s.disabled_modules)
    ),
    'roles', coalesce((
      select jsonb_agg(jsonb_build_object('key', x.key, 'name', x.name, 'permissions', x.permissions, 'coverage', x.coverage)
        order by x.position, x.name)
      from public.school_roles x where x.school_id = s.id and not x.system
    ), '[]'::jsonb)
  )
  from public.profiles p
  join public.schools s on s.id = p.school_id
  left join public.school_roles r on r.school_id = p.school_id and r.key = p.role
  where p.id = auth.uid() and p.active and s.active
$$;

create or replace function public.platform_schools()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(row_to_json(x) order by x.created_at desc), '[]'::jsonb) from (
    select s.id, s.code, s.name, s.active, s.created_at, s.icon_version, s.disabled_modules,
      (ss.teams_webhook_url is not null) as has_teams,
      (select count(*) from public.profiles p where p.school_id = s.id and p.role <> 'admin' and p.active) as employees,
      (select count(*) from public.absences a where a.school_id = s.id) as absences,
      (select max(a.created_at) from public.absences a where a.school_id = s.id) as last_absence_at,
      (select count(*) from public.profiles p where p.school_id = s.id and p.active
         and p.last_login_at >= date_trunc('month', now())) as active_month,
      (select max(p.last_login_at) from public.profiles p where p.school_id = s.id) as last_login_at,
      (select count(*) from public.service_requests r where r.school_id = s.id
         and r.created_at >= date_trunc('month', now())) as turns_month,
      (select count(*) from public.student_alerts a where a.school_id = s.id
         and a.created_at >= date_trunc('month', now())) as alerts_month,
      (select count(*) from public.maintenance_requests m where m.school_id = s.id
         and m.created_at >= date_trunc('month', now())) as maintenance_month,
      (select count(*) from public.room_bookings b where b.school_id = s.id
         and b.created_at >= date_trunc('month', now())) as bookings_month,
      (select coalesce(sum((o.metadata ->> 'size')::bigint), 0) from storage.objects o
         where split_part(o.name, '/', 1) = s.id::text) as storage_bytes
    from public.schools s
    left join public.school_settings ss on ss.school_id = s.id
  ) x
$$;
