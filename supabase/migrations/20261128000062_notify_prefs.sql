-- Each person can turn off the phone/computer alerts (push) of specific kinds of notices: turns, relief, visits…
-- The notice still appears inside the app (bell), so nothing is lost; only the alert that sounds is skipped.
-- Notices about the person's account (passwords, access) and other general ones can't be turned off.

alter table public.profiles add column if not exists notify_off text[] not null default '{}';

-- The kind of a notice, from where it opens (the same groups the bell screen shows).
create or replace function private.notice_kind(p_link text)
returns text
language sql immutable set search_path = ''
as $$
  select case
    when p_link ~ '^#/(absence|cover|dashboard|absences|home)\y' then 'absences'
    when p_link ~ '^#/turns\y' then 'turns'
    when p_link ~ '^#/alerts/(missing|new/missing)\y' then 'alerts'
    when p_link ~ '^#/alerts/pickup\y' then 'pickups'
    when p_link ~ '^#/alerts/relief\y' then 'relief'
    when p_link ~ '^#/alerts/visit\y' then 'visits'
    when p_link ~ '^#/maintenance\y' then 'maintenance'
    when p_link ~ '^#/rooms\y' then 'rooms'
    when p_link ~ '^#/messages?\y' then 'messages'
    when p_link ~ '^#/summary\y' then 'summary'
    when p_link ~ '^#/employees\y' then 'staff'
    else 'other'
  end
$$;

create or replace function private.queue_push()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (
    select 1 from public.profiles p
    where p.id = new.user_id and private.notice_kind(coalesce(new.link, '')) = any(p.notify_off)
  ) then
    return new;
  end if;
  insert into public.outbox (kind, payload) values ('push', jsonb_build_object('notification_id', new.id));
  return new;
end;
$$;

create or replace function public.set_my_notify_off(p_kinds text[])
returns text[]
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v text[];
begin
  select coalesce(array_agg(distinct k order by k), '{}') into v
  from unnest(coalesce(p_kinds, '{}')) k
  where k in ('absences', 'turns', 'alerts', 'pickups', 'relief', 'visits', 'maintenance', 'rooms', 'messages', 'summary');
  update public.profiles set notify_off = v where id = me.id;
  return v;
end;
$$;

revoke execute on function public.set_my_notify_off(text[]) from public, anon;
grant execute on function public.set_my_notify_off(text[]) to authenticated;

create or replace function public.me()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'user', jsonb_build_object(
      'id', p.id, 'role', p.role, 'username', p.username, 'full_name', p.full_name, 'email', p.email,
      'phone', p.phone, 'position', p.position, 'employee_number', p.employee_number,
      'must_change_password', p.must_change_password, 'language', p.language, 'notify_off', to_jsonb(p.notify_off),
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
