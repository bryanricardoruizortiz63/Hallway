-- The turns stay as a record: besides whoever attends the service (and the teacher, for 24 hours), the Admin,
-- Director(a) and whoever has «En vivo» or «Resumen del día» can open any turn of the school, closed or not
-- (from the history, the summary or a notice). Before, opening an old turn gave «No se encontró el turno».

create or replace function private.sees_all_turns()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select private.history_full(p) or private.can(p, 'live') or private.can(p, 'summary')
    from public.profiles p where p.id = auth.uid() and p.active), false)
$$;
revoke execute on function private.sees_all_turns() from public, anon;
grant execute on function private.sees_all_turns() to authenticated;

drop policy if exists "Ver turnos" on public.service_requests;
create policy "Ver turnos" on public.service_requests for select to authenticated using (
  school_id = (select private.my_school_id()) and (
    private.serves(service_id)
    or (select private.sees_all_turns())
    or (created_by = (select auth.uid()) and status <> all (array['done', 'cancelled']))
    or (created_at > now() - interval '24 hours' and (
      created_by = (select auth.uid()) or teacher_id = (select auth.uid())
      or group_name = any (coalesce((select p.groups from public.profiles p where p.id = (select auth.uid())), '{}'::text[]))))
  )
);

drop policy if exists "Ver motivo del turno" on public.service_request_details;
create policy "Ver motivo del turno" on public.service_request_details for select to authenticated using (
  school_id = (select private.my_school_id()) and (
    private.serves(service_id)
    or (select private.sees_all_turns())
    or (created_by = (select auth.uid()) and (created_at > now() - interval '24 hours'
      or exists (select 1 from public.service_requests r where r.id = service_request_details.request_id
                 and r.status <> all (array['done', 'cancelled']))))
  )
);
