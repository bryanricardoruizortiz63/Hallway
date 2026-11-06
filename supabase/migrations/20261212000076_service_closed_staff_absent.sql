-- A service whose whole staff is absent now can't receive turns. The app already said so, but the server didn't stop
-- it, so a phone with an older copy of the app could still ask (it happened with Soporte IT). Now the server refuses
-- it too, with the same words the app shows; whoever attends the service can still note one.

/** Every person who attends the service is absent right now (in the school's time zone). False with nobody assigned. */
create or replace function private.service_staff_absent(s public.school_services)
returns boolean
language sql stable security definer set search_path = ''
as $$
  with local as (
    select now() at time zone coalesce(
      (select st.time_zone from public.school_settings st where st.school_id = s.school_id), 'America/Puerto_Rico') as t
  ), staff as (
    select p.id from public.profiles p
    where p.school_id = s.school_id and p.active and private.roles_of(p) && s.roles
  )
  select exists (select 1 from staff) and not exists (
    select 1 from staff p, local
    where not exists (
      select 1 from public.absences a
      where a.user_id = p.id and a.status <> 'cancelled'
        and local.t::date between a.start_date and a.end_date
        and (not a.partial or (local.t::time >= coalesce(a.start_time, '00:00')
             and (a.end_time is null or local.t::time < a.end_time)))
    )
  )
$$;

/** Why the service can't take turns right now (null: it can). Same as in 20261205000069, with the staff absent. */
create or replace function private.service_closed(s public.school_services)
returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  st public.school_settings;
  v_local timestamp;
  v_opens time;
  v_closes time;
begin
  select * into st from public.school_settings x where x.school_id = s.school_id;
  v_local := now() at time zone coalesce(st.time_zone, 'America/Puerto_Rico');
  select h.opens, h.closes into v_opens, v_closes from private.service_hours(s) h;
  if not (extract(isodow from v_local)::int = any(coalesce(st.school_days, '{1,2,3,4,5}'))) or exists (
    select 1 from public.school_closures c
    where c.school_id = s.school_id and v_local::date between c.start_date and c.end_date
  ) then
    return format('Hoy no hay clases: %s no recibe turnos.', s.name);
  end if;
  if v_local::time < v_opens or v_local::time >= v_closes then
    return format('%s recibe turnos de %s a %s. Ahora está fuera de su horario.', s.name,
      private.time_text(v_opens), private.time_text(v_closes));
  end if;
  if private.service_staff_absent(s) then
    return format('%s no está disponible en este momento: el personal del servicio se encuentra ausente. Para una situación urgente, comunícate con la oficina.', s.name);
  end if;
  return null;
end;
$$;
