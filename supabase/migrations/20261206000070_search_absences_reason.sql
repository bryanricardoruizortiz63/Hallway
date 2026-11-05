-- «Buscar ausencias» also shows the type and the reason: whoever has the permission sends the chosen absences, with
-- every detail, to Human Resources (as a PDF or an image). Same as in 20261205000069, with category and reason.

create or replace function public.search_absences(p_name text, p_from date, p_to date, p_group text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_group text := nullif(btrim(coalesce(p_group, '')), '');
begin
  if not (private.can(me, 'absence_search') or private.can(me, 'absences')) then
    raise exception 'No tienes permiso para buscar ausencias.';
  end if;
  return coalesce((
    select jsonb_agg(x order by x->>'start_date' desc, x->>'employee_name')
    from (
      select jsonb_build_object(
        'id', a.id, 'employee_name', p.full_name, 'employee_position', p.position, 'groups', to_jsonb(p.groups),
        'start_date', a.start_date, 'end_date', a.end_date, 'partial', a.partial,
        'start_time', to_char(a.start_time, 'HH24:MI'), 'end_time', to_char(a.end_time, 'HH24:MI'),
        'status', a.status, 'created_at', a.created_at, 'category', a.category, 'reason', a.reason,
        'covers', (select coalesce(jsonb_agg(c ->> 'name'), '[]'::jsonb) from jsonb_array_elements(coalesce(a.covers, '[]'::jsonb)) c),
        'cover_groups', (select coalesce(jsonb_agg(distinct g), '[]'::jsonb)
          from jsonb_array_elements(coalesce(a.covers, '[]'::jsonb)) c, jsonb_array_elements_text(coalesce(c -> 'groups', '[]'::jsonb)) g),
        'no_cover', a.no_cover) as x
      from public.absences a
      join public.profiles p on p.id = a.user_id
      where a.school_id = me.school_id and a.status <> 'cancelled'
        and (p_from is null or a.end_date >= p_from) and (p_to is null or a.start_date <= p_to)
        and (v_name is null or p.full_name ilike '%' || v_name || '%')
        and (v_group is null or v_group = any(p.groups) or exists (
          select 1 from jsonb_array_elements(coalesce(a.covers, '[]'::jsonb)) c
          where coalesce(c -> 'groups', '[]'::jsonb) ? v_group))
      limit 500
    ) t(x)
  ), '[]'::jsonb);
end;
$$;
revoke execute on function public.search_absences(text, date, date, text) from public, anon;
grant execute on function public.search_absences(text, date, date, text) to authenticated;

-- «Buscar mis ausencias»: one's own reason too.
create or replace function public.search_my_absences(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
begin
  if not private.can(me, 'own_absence_search') then raise exception 'No tienes permiso para buscar tus ausencias.'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'id', a.id, 'employee_name', me.full_name, 'employee_position', me.position,
        'start_date', a.start_date, 'end_date', a.end_date, 'partial', a.partial,
        'start_time', to_char(a.start_time, 'HH24:MI'), 'end_time', to_char(a.end_time, 'HH24:MI'),
        'status', a.status, 'created_at', a.created_at, 'category', a.category, 'reason', a.reason,
        'covers', (select coalesce(jsonb_agg(c ->> 'name'), '[]'::jsonb) from jsonb_array_elements(coalesce(a.covers, '[]'::jsonb)) c),
        'no_cover', a.no_cover)
      order by a.start_date desc)
    from public.absences a
    where a.user_id = me.id
      and (p_from is null or a.end_date >= p_from) and (p_to is null or a.start_date <= p_to)
  ), '[]'::jsonb);
end;
$$;
revoke execute on function public.search_my_absences(date, date) from public, anon;
grant execute on function public.search_my_absences(date, date) to authenticated;
