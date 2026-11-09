-- The version of the app each person has on their phone, so whoever manages the staff can see in their file whether
-- it is up to date (Personal › the person). The app reports it each time it opens; Más shows one's own and lets
-- them look for an update.

alter table public.profiles add column if not exists app_version text;
alter table public.profiles add column if not exists app_version_at timestamptz;

/** The app on this phone says which version it is (the fingerprint in sw.js, e.g. «lah-6cddb6db0f8f»). */
create or replace function public.set_my_app_version(p_version text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_version is null or p_version !~ '^lah-[0-9a-f]{12}$' then raise exception 'Versión no válida.'; end if;
  update public.profiles set app_version = p_version, app_version_at = now() where id = auth.uid();
end;
$$;
revoke execute on function public.set_my_app_version(text) from public, anon;
grant execute on function public.set_my_app_version(text) to authenticated;

-- Same as in 20261117000051, with the app's version at the end.
create or replace view public.employees_v with (security_invoker = true) as
select p.id, p.school_id, p.role, p.username, p.full_name, p.email, p.phone, p.employee_number, p."position",
  p.active, p.must_change_password, p.last_login_at, p.created_at, p.updated_at,
  (select count(*) from public.absences a where a.user_id = p.id and a.status <> 'cancelled')::integer as absence_count,
  p.password_help_at, p.room, p.groups,
  p.require_mfa,
  private.has_mfa(p.id) as mfa_ready,
  p.extra_roles,
  p.app_version, p.app_version_at
from public.profiles p
where p.role <> 'admin';
