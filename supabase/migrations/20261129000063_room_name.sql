-- Reservations: each school names the place that is reserved (not always a "Salón de conferencias"), and the
-- school's Admin can turn reservations off when the school has no such place.

alter table public.school_settings add column if not exists room_name text
  check (room_name is null or char_length(room_name) between 2 and 60);

create or replace function private.calendar_json(p_school uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'day_start', to_char(coalesce(s.day_start, '07:40'), 'HH24:MI'),
    'day_end', to_char(coalesce(s.day_end, '15:30'), 'HH24:MI'),
    'school_days', to_jsonb(coalesce(s.school_days, '{1,2,3,4,5}')),
    'groups', to_jsonb(coalesce(s.groups, '{}')),
    'room_start', to_char(coalesce(s.room_start, s.day_start, '07:40'), 'HH24:MI'),
    'room_end', to_char(coalesce(s.room_end, s.day_end, '15:30'), 'HH24:MI'),
    'room_name', s.room_name
  )
  from (select 1) x
  left join public.school_settings s on s.school_id = p_school
$$;

/** The Admin: the name of the place, and whether the school uses reservations. Returns the calendar. */
create or replace function public.save_room_settings(p_name text, p_enabled boolean)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_name text := nullif(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), '');
begin
  if not private.is_admin(me) then raise exception 'Solo el Admin de la escuela puede cambiar esto.'; end if;
  if v_name is not null and char_length(v_name) not between 2 and 60 then
    raise exception 'El nombre debe tener entre 2 y 60 letras.';
  end if;
  insert into public.school_settings (school_id, room_name) values (me.school_id, v_name)
  on conflict (school_id) do update set room_name = excluded.room_name;
  update public.schools s
  set disabled_modules = case when coalesce(p_enabled, true)
    then array_remove(s.disabled_modules, 'rooms')
    else array_append(array_remove(s.disabled_modules, 'rooms'), 'rooms') end
  where s.id = me.school_id;
  perform private.log_activity(me.school_id, me.id,
    case when coalesce(p_enabled, true) then 'Cambió las reservas de la escuela' else 'Apagó las reservas de la escuela' end,
    'Nombre: ' || coalesce(v_name, 'Salón de conferencias'), null, null);
  return private.calendar_json(me.school_id);
end;
$$;
revoke execute on function public.save_room_settings(text, boolean) from public, anon;
grant execute on function public.save_room_settings(text, boolean) to authenticated;
