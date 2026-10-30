-- Each person picks the language of the app (Spanish or English); it follows them to any device.
alter table public.profiles add column if not exists language text not null default 'es'
  check (language in ('es', 'en'));

create or replace function public.set_my_language(p_language text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
begin
  if p_language not in ('es', 'en') then raise exception 'Idioma no válido.'; end if;
  update public.profiles set language = p_language where id = me.id;
end;
$$;

revoke execute on function public.set_my_language(text) from public, anon;
grant execute on function public.set_my_language(text) to authenticated;

create or replace function public.me()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'user', jsonb_build_object(
      'id', p.id, 'role', p.role, 'username', p.username, 'full_name', p.full_name, 'email', p.email,
      'phone', p.phone, 'position', p.position, 'employee_number', p.employee_number,
      'must_change_password', p.must_change_password, 'language', p.language,
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
