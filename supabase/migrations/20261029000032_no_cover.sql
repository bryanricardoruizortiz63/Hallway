-- Cobertura: «Nadie cubrirá». When an absence needs coverage but nobody will cover it, whoever handles coverage
-- (permission «Ver y confirmar las ausencias de todos») says so and why: it isn't needed (not_needed) or there is
-- nobody to cover (no_one). It stops showing as «Sin cubrir» and says who decided it and when. Assigning someone
-- undoes it; marking it takes off whoever covered (they are told, as when the list is emptied).

alter table public.absences
  add column no_cover text check (no_cover in ('not_needed', 'no_one')),
  add column no_cover_by_name text,
  add column no_cover_at timestamptz;

-- The view picks up the new columns (at the end, so it can be replaced in place).
create or replace view public.absences_v with (security_invoker = true) as
select
  a.id, a.school_id, a.user_id, a.created_by, a.created_by_name, a.start_date, a.end_date, a.partial, a.start_time,
  a.end_time, a.category, a.reason, a.coverage_notes, a.status, a.received_by, a.received_by_name, a.received_at,
  a.substitute, a.cancelled_at, a.created_at, a.updated_at,
  p.full_name as employee_name,
  p.position as employee_position,
  p.role as employee_role,
  (select count(*) from public.attachments t where t.absence_id = a.id)::integer as attachment_count,
  (select count(*) from public.comments c where c.absence_id = a.id)::integer as comment_count,
  a.substitute_id, a.cover_groups, a.cover_room, a.cover_set_by_name, a.cover_set_at,
  p.room as employee_room,
  p.groups as employee_groups,
  a.covers,
  a.no_cover, a.no_cover_by_name, a.no_cover_at
from public.absences a
join public.profiles p on p.id = a.user_id;

/** Someone assigned to cover: it's no longer «Nadie cubrirá». */
create or replace function private.covers_undo_no_cover()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.covers <> '[]'::jsonb then
    new.no_cover := null;
    new.no_cover_by_name := null;
    new.no_cover_at := null;
  end if;
  return new;
end;
$$;

create trigger absences_covers_undo_no_cover
before update of covers on public.absences
for each row when (new.covers is distinct from old.covers)
execute function private.covers_undo_no_cover();

/**
 * «Nadie cubrirá»: p_reason 'not_needed' (no hace falta) or 'no_one' (no hay quién cubra); null undoes it (it shows
 * as «Sin cubrir» again). Whoever covered is taken off and told.
 */
create or replace function public.set_absence_no_cover(p_id bigint, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  a public.absences := private.load_absence(p_id, me);
begin
  if not private.can(me, 'absences') then
    raise exception 'No tienes permiso para realizar esta acción.';
  end if;
  if a.status = 'cancelled' then
    raise exception 'La ausencia está cancelada.';
  end if;
  if p_reason is not null and p_reason not in ('not_needed', 'no_one') then
    raise exception 'Elige por qué nadie cubrirá.';
  end if;
  if p_reason is not null and a.covers <> '[]'::jsonb then
    perform public.set_absence_covers(p_id, '[]'::jsonb);
  end if;
  update public.absences
  set no_cover = p_reason,
      no_cover_by_name = case when p_reason is null then null else me.full_name end,
      no_cover_at = case when p_reason is null then null else now() end,
      updated_at = now()
  where id = a.id and no_cover is distinct from p_reason;
end;
$$;

revoke execute on function public.set_absence_no_cover(bigint, text) from public, anon;
grant execute on function public.set_absence_no_cover(bigint, text) to authenticated;
