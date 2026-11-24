-- Whoever decides the coverage of an absence has seen it: when someone who confirms absences (Dirección, Secretaría…)
-- puts someone to cover it, or says it doesn't need cover / there's nobody, and it is still «Enviada», it becomes
-- «Recibida» by that person, as if they had tapped «Recibido»: the same history line and the same notice to whoever is
-- absent. The absent person themselves (who may suggest who covers) doesn't count.

create or replace function private.cover_marks_received()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles;
begin
  if new.status <> 'pending' then return null; end if;
  -- Only when someone is now covering, or the absence was marked as not covered.
  if not ((new.covers is distinct from old.covers and new.covers <> '[]'::jsonb)
          or (new.no_cover is not null and new.no_cover is distinct from old.no_cover)) then
    return null;
  end if;
  select * into me from public.profiles p where p.id = auth.uid() and p.active;
  if me.id is null or me.id = new.user_id or me.school_id <> new.school_id or not private.can(me, 'absences') then
    return null;
  end if;

  update public.absences
  set status = 'received', received_by = me.id, received_by_name = me.full_name, received_at = now(), updated_at = now()
  where id = new.id and status = 'pending';
  insert into public.absence_history (absence_id, school_id, actor_id, actor_name, action)
  values (new.id, new.school_id, me.id, me.full_name, 'received');
  perform private.notify(
    array[new.user_id], 'Tu ausencia fue recibida ✅',
    'Confirmada por ' || me.full_name || (case when new.no_cover is not null and new.covers = '[]'::jsonb
      then '.' else ' al asignar quién te cubre.' end),
    '#/absence/' || new.id
  );
  return null;
end;
$$;
revoke execute on function private.cover_marks_received() from public, anon, authenticated;

drop trigger if exists absences_cover_marks_received on public.absences;
create trigger absences_cover_marks_received
after update of covers, no_cover on public.absences
for each row execute function private.cover_marks_received();
