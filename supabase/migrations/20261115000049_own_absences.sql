-- Roles y permisos: «Reportar sus propias ausencias» deja de ser fijo. Cada rol puede tenerlo o no (por ejemplo,
-- Coordinador IT, que no reporta las suyas en Hallway). Sin él, la persona no ve «Mis ausencias» ni «Reportar mi
-- ausencia»; si además registra ausencias del personal, solo registra las de otros (como la cuenta de Administración).
--   * school_roles.own_absences (sí por defecto: todo sigue igual hasta que alguien lo quite).
--   * me() lo devuelve en user.own_absences y en cada rol de roles.
--   * create_absence no deja reportar una ausencia propia a quien su rol no lo permite.

alter table public.school_roles add column own_absences boolean not null default true;

-- Same as in 20261114000048, with own_absences.
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
      'own_absences', coalesce(r.own_absences, true) and p.role <> 'admin',
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

-- Same as in 20261101000035, but your own absence only when your role reports them.
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
    if not coalesce((select r.own_absences from public.school_roles r where r.school_id = me.school_id and r.key = me.role), true) then
      raise exception 'Tu rol no reporta sus propias ausencias en Hallway. Si hace falta, pídeselo a la dirección.';
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
    if p_end_time is null then
      raise exception 'Indica la hora final de la ausencia.';
    end if;
    if p_end_time <= p_start_time then
      raise exception 'La hora final debe ser después de la hora de inicio.';
    end if;
    v_start_time := p_start_time;
    v_end_time := p_end_time;
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
