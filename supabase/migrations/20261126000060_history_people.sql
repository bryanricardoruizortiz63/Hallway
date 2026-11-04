-- Historial del personal: the people whose history can be opened (also the deactivated ones), for the permission «history».
create or replace function public.history_people()
returns table (id uuid, full_name text, job text, role text, active boolean, actions bigint, last_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
begin
  if not private.can(me, 'history') then raise exception 'No tienes permiso para ver el historial.'; end if;
  return query
    select p.id, p.full_name, p.position, p.role, p.active,
      (select count(*) from public.activity_log l where l.actor_id = p.id),
      (select max(l.at) from public.activity_log l where l.actor_id = p.id)
    from public.profiles p
    where p.school_id = me.school_id
    order by p.active desc, p.full_name;
end;
$$;
revoke execute on function public.history_people() from public, anon;
grant execute on function public.history_people() to authenticated;
