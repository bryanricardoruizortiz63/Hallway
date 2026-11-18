-- «Atendiendo un turno»: whoever attends a service shows as busy while one of their turns is in course (the student is
-- in their office, or they are on their way to the classroom), not as «Disponible». Only who and since when: never the
-- student or the reason.

/** People of my school attending a turn right now: { user_id, service_id, since }. */
create or replace function public.staff_busy()
returns table (user_id uuid, service_id bigint, since timestamptz)
language sql stable security definer set search_path = ''
as $$
  select distinct on (r.handled_by) r.handled_by, r.service_id, coalesce(r.arrived_at, r.on_the_way_at, r.created_at)
  from public.service_requests r
  where r.school_id = private.my_school_id()
    and r.handled_by is not null
    and r.status in ('arrived', 'on_the_way')
    and r.created_at > now() - interval '2 days'
  order by r.handled_by, coalesce(r.arrived_at, r.on_the_way_at, r.created_at)
$$;
revoke execute on function public.staff_busy() from public, anon;
grant execute on function public.staff_busy() to authenticated;
