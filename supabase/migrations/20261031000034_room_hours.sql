-- Salón de conferencias: its own hours, apart from the class hours. Until now a reservation had to be within the class
-- hours, so a school that lends the room in the evening had to stretch its class hours (and with them the coverage
-- reminders and the day's summary).
--   * school_settings.room_start / room_end: when the room can be reserved (on school days, never on a day without
--     classes). Empty, it's the class hours. Each school starts with the hours its room has today, so no reservation
--     stops fitting; then the class hours can go back to the real ones.
--   * save_room_hours (permission «Calendario escolar»), and calendar_json gives them to the app.

alter table public.school_settings
  add column room_start time,
  add column room_end time,
  add constraint school_settings_room_hours_check check (room_end > room_start);

update public.school_settings set room_start = day_start, room_end = day_end where room_start is null;

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
    'room_end', to_char(coalesce(s.room_end, s.day_end, '15:30'), 'HH24:MI')
  )
  from (select 1) x
  left join public.school_settings s on s.school_id = p_school
$$;

/** When the conference room can be reserved, on school days. Returns the school's calendar. */
create or replace function public.save_room_hours(p_start time, p_end time)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_calendar();
begin
  if p_start is null or p_end is null then raise exception 'Indica desde qué hora y hasta qué hora se puede reservar.'; end if;
  if p_end <= p_start then raise exception 'La hora final debe ser después de la inicial.'; end if;
  insert into public.school_settings (school_id, room_start, room_end)
  values (me.school_id, p_start, p_end)
  on conflict (school_id) do update set room_start = excluded.room_start, room_end = excluded.room_end;
  return private.calendar_json(me.school_id);
end;
$$;

revoke execute on function public.save_room_hours(time, time) from public, anon;
grant execute on function public.save_room_hours(time, time) to authenticated;

/** Free times that day within the room's hours (15 minutes or more): "7:00 a. m. – 9:00 a. m., 11:00 a. m. – 9:00 p. m.". */
create or replace function private.room_free_text(p_school uuid, p_day date)
returns text
language sql stable security definer set search_path = ''
as $$
  with hours as (
    select coalesce(s.room_start, s.day_start, '07:40'::time) as a, coalesce(s.room_end, s.day_end, '15:30'::time) as b
    from (select 1) x left join public.school_settings s on s.school_id = p_school
  ),
  busy as (
    select greatest(r.start_time, h.a) as s, least(r.end_time, h.b) as e
    from public.room_bookings r, hours h
    where r.school_id = p_school and r.day = p_day and r.status = 'approved' and r.end_time > h.a and r.start_time < h.b
  ),
  -- Approved reservations never overlap: the gaps are from the start of the day, and from the end of each one,
  -- to the next one (or the end of the day).
  gaps as (
    select h.a as gs, coalesce((select min(s) from busy), h.b) as ge from hours h
    union all
    select b1.e, coalesce((select min(b2.s) from busy b2 where b2.s >= b1.e), h.b) from busy b1, hours h
  )
  select string_agg(private.time_text(gs) || ' – ' || private.time_text(ge), ', ' order by gs)
  from gaps where ge - gs >= interval '15 minutes'
$$;

/** The day and times can be reserved: a school day, within the room's hours and not a day without classes. */
create or replace function private.check_room_time(p_school uuid, p_day date, p_start time, p_end time)
returns void
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_room_start time;
  v_room_end time;
  v_days smallint[];
  c public.school_closures;
begin
  if p_day is null then raise exception 'Elige el día.'; end if;
  if p_start is null or p_end is null then raise exception 'Elige la hora de inicio y la de fin.'; end if;
  if p_end <= p_start then raise exception 'La hora de fin debe ser después de la de inicio.'; end if;
  if p_end - p_start < interval '15 minutes' then raise exception 'Reserva al menos 15 minutos.'; end if;
  select coalesce(s.room_start, s.day_start, '07:40'), coalesce(s.room_end, s.day_end, '15:30'), coalesce(s.school_days, '{1,2,3,4,5}')
  into v_room_start, v_room_end, v_days
  from (select 1) x left join public.school_settings s on s.school_id = p_school;
  if not extract(isodow from p_day)::smallint = any(v_days) then
    raise exception 'Ese día no hay clases (%). Elige un día de clases.', private.fmt_date(p_day);
  end if;
  if p_start < v_room_start or p_end > v_room_end then
    raise exception 'Elige una hora dentro del horario del salón: de % a %', private.time_text(v_room_start), private.time_text(v_room_end);
  end if;
  select * into c from public.school_closures x
  where x.school_id = p_school and p_day between x.start_date and x.end_date
  order by (x.kind = 'holiday') desc limit 1;
  if c.id is not null then
    raise exception 'Ese día no se puede reservar: % (%).', c.name, case c.kind when 'holiday' then 'feriado' else 'sin estudiantes' end;
  end if;
end;
$$;
