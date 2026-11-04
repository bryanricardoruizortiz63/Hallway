-- 1. How long a service's turns last: closed at the end of the school day (like Enfermería) or kept open until
--    someone closes them (like Soporte IT). Editable in Servicios.
-- 2. Turns kept from earlier days: whoever attends the service is asked, once a day, whether each one goes on or is
--    closed.
-- 3. The activity history: what each person did, when and the details, for whoever has the permission «history».
--    Student names never go in it (they are deleted after 24 hours elsewhere), nor the private cause of an absence.

alter table public.school_services add column if not exists keep_open boolean not null default false;
update public.school_services set keep_open = true where mode = 'support' and not keep_open;
alter table public.service_requests add column if not exists carried_checked_at timestamptz;
alter table public.service_requests add column if not exists carried_checked_by_name text;

-- ---- The activity history ------------------------------------------------------------------------------------

create table if not exists public.activity_log (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools on delete cascade,
  at timestamptz not null default now(),
  actor_id uuid references public.profiles on delete set null,
  actor_name text not null,
  action text not null check (char_length(action) <= 200),
  details text check (char_length(details) <= 1000),
  link text check (char_length(link) <= 200),
  -- Someone else the action was about (whose absence was recorded, who was given a role…).
  subject_id uuid references public.profiles on delete set null
);
create index if not exists activity_log_actor on public.activity_log (actor_id, at desc);
create index if not exists activity_log_subject on public.activity_log (subject_id, at desc);
create index if not exists activity_log_school on public.activity_log (school_id, at desc);
alter table public.activity_log enable row level security;
-- No policies: only through the functions below (and the server's own functions).
revoke all on public.activity_log from anon, authenticated;

/** One line of the history. With no actor (the system or a job), it says «Hallway». */
create or replace function private.log_activity(
  p_school uuid, p_actor uuid, p_action text, p_details text default null, p_link text default null, p_subject uuid default null
)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_school is null or p_action is null then return; end if;
  insert into public.activity_log (school_id, actor_id, actor_name, action, details, link, subject_id)
  values (p_school, p_actor,
    coalesce((select p.full_name from public.profiles p where p.id = p_actor), 'Hallway'),
    left(p_action, 200), left(p_details, 1000), left(p_link, 200),
    case when p_subject is distinct from p_actor then p_subject end);
end;
$$;
revoke execute on function private.log_activity(uuid, uuid, text, text, text, uuid) from public, anon, authenticated;

/** «lunes 3 nov · 8:00 a. m. – 11:00 a. m.» */
create or replace function private.absence_when(a public.absences)
returns text
language sql immutable set search_path = ''
as $$
  select concat_ws(' · ',
    case when a.start_date = a.end_date then to_char(a.start_date, 'DD/MM/YYYY')
      else to_char(a.start_date, 'DD/MM/YYYY') || ' al ' || to_char(a.end_date, 'DD/MM/YYYY') end,
    case when not a.partial then 'día completo'
      when a.end_time is null then 'desde ' || to_char(a.start_time, 'HH12:MI AM')
      else to_char(a.start_time, 'HH12:MI AM') || ' – ' || to_char(a.end_time, 'HH12:MI AM') end)
$$;

create or replace function private.log_absence()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_name text;
  a public.absences := coalesce(new, old);
  v_who text;
begin
  select p.full_name into v_name from public.profiles p where p.id = a.user_id;
  v_who := case when v_actor = a.user_id then 'su ausencia' else 'la ausencia de ' || coalesce(v_name, 'un empleado') end;
  if tg_op = 'INSERT' then
    perform private.log_activity(a.school_id, v_actor,
      case when v_actor = a.user_id then 'Reportó una ausencia' else 'Registró la ausencia de ' || coalesce(v_name, 'un empleado') end,
      private.absence_when(a), '#/absence/' || a.id, a.user_id);
  elsif tg_op = 'DELETE' then
    perform private.log_activity(a.school_id, v_actor, 'Borró ' || v_who, private.absence_when(a), null, a.user_id);
  else
    if new.status = 'cancelled' and old.status <> 'cancelled' then
      perform private.log_activity(a.school_id, v_actor, 'Canceló ' || v_who, private.absence_when(a), '#/absence/' || a.id, a.user_id);
    elsif new.status = 'received' and old.status <> 'received' then
      perform private.log_activity(a.school_id, v_actor, 'Confirmó el recibo de ' || v_who, private.absence_when(a), '#/absence/' || a.id, a.user_id);
    end if;
    if (new.start_date, new.end_date, new.partial, new.start_time, new.end_time)
       is distinct from (old.start_date, old.end_date, old.partial, old.start_time, old.end_time) then
      perform private.log_activity(a.school_id, v_actor, 'Modificó ' || v_who,
        'Antes: ' || private.absence_when(old) || '. Ahora: ' || private.absence_when(new) || '.', '#/absence/' || a.id, a.user_id);
    end if;
    if new.covers is distinct from old.covers or new.no_cover is distinct from old.no_cover then
      perform private.log_activity(a.school_id, v_actor, 'Cambió quién cubre ' || v_who,
        case when new.no_cover is not null then 'Nadie cubrirá.'
          else nullif(concat_ws(', ', (select string_agg(distinct x ->> 'name', ', ') from jsonb_array_elements(coalesce(new.covers, '[]'::jsonb)) x)), '') end,
        '#/absence/' || a.id, a.user_id);
    end if;
  end if;
  return null;
end;
$$;
drop trigger if exists absences_log on public.absences;
create trigger absences_log after insert or update or delete on public.absences for each row execute function private.log_absence();

create or replace function private.log_attachment()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  f public.attachments := coalesce(new, old);
begin
  perform private.log_activity(f.school_id, auth.uid(),
    case when tg_op = 'INSERT' then 'Subió un documento a una ausencia' else 'Borró un documento de una ausencia' end,
    f.original_name, '#/absence/' || f.absence_id, null);
  return null;
end;
$$;
drop trigger if exists attachments_log on public.attachments;
create trigger attachments_log after insert or delete on public.attachments for each row execute function private.log_attachment();

/** «un estudiante de 6-B» or, for Soporte IT, what it was and where. Never the student's name. */
create or replace function private.turn_label(r public.service_requests)
returns text
language sql stable security definer set search_path = ''
as $$
  select case when s.mode = 'support'
      then coalesce((select d.reason from public.service_request_details d where d.request_id = r.id), 'un pedido de ayuda')
        || coalesce(' (' || r.room || ')', '')
      else 'un estudiante de ' || coalesce(r.group_name, 'otro grupo') end
  from public.school_services s where s.id = r.service_id
$$;

create or replace function private.log_turn()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_service text := (select s.name from public.school_services s where s.id = new.service_id);
  v_what text := private.turn_label(new);
  v_link text := '#/turns/' || new.id;
  v_action text;
begin
  if tg_op = 'INSERT' then
    v_action := case when new.status = 'arrived' then format('Anotó en %s a %s que llegó sin turno', v_service, v_what)
      else format('Pidió turno en %s para %s', v_service, v_what) end;
    perform private.log_activity(new.school_id, auth.uid(), v_action,
      concat_ws(' · ', (select d.reason from public.service_request_details d where d.request_id = new.id),
        case when new.room is not null then 'salón ' || new.room end), v_link, null);
    return null;
  end if;
  if new.status is not distinct from old.status then return null; end if;
  v_action := case new.status
    when 'called' then format('Llamó a %s a %s', v_what, v_service)
    when 'sent' then format('Envió a %s a %s', v_what, v_service)
    when 'arrived' then format('Marcó que %s llegó a %s', v_what, v_service)
    when 'on_the_way' then format('Fue a atender a %s (%s)', v_what, v_service)
    when 'returning' then format('Envió de regreso al salón a %s (%s)', v_what, v_service)
    when 'done' then format('Cerró el turno de %s en %s', v_what, v_service)
    when 'cancelled' then case when new.outcome = 'expired'
      then format('Cerró sin atender el turno de %s en %s', v_what, v_service)
      else format('Canceló el turno de %s en %s', v_what, v_service) end
    else null end;
  if v_action is null then return null; end if;
  perform private.log_activity(new.school_id, auth.uid(), v_action,
    case new.outcome
      when 'returned' then 'Regresó al salón.' when 'picked_up' then 'Lo recogieron.' when 'referred' then 'Referido / con seguimiento.'
      when 'attended' then 'Atendido.' when 'expired' then 'Nadie lo atendió antes del final del día.'
      when 'unconfirmed' then 'Regreso sin confirmar.' else null end,
    v_link, null);
  return null;
end;
$$;
drop trigger if exists service_requests_log on public.service_requests;
create trigger service_requests_log after insert or update of status on public.service_requests
  for each row execute function private.log_turn();

create or replace function private.log_maintenance()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_kind text := case new.kind when 'spill' then 'derrame' when 'cleaning' then 'limpieza' when 'bathroom' then 'baño'
    when 'trash' then 'basura' when 'repair' then 'reparación' else 'otro' end;
  v_what text := format('%s en %s', v_kind, new.place);
begin
  if tg_op = 'INSERT' then
    perform private.log_activity(new.school_id, auth.uid(), 'Pidió mantenimiento: ' || v_what, new.note, '#/maintenance/' || new.id, null);
  elsif new.status is distinct from old.status then
    perform private.log_activity(new.school_id, auth.uid(),
      case new.status when 'on_the_way' then 'Fue a atender mantenimiento: ' when 'done' then 'Terminó mantenimiento: '
        when 'cancelled' then 'Canceló mantenimiento: ' when 'pending' then 'Devolvió a pendiente mantenimiento: ' else 'Cambió mantenimiento: ' end || v_what,
      new.close_note, '#/maintenance/' || new.id, null);
  end if;
  return null;
end;
$$;
drop trigger if exists maintenance_requests_log on public.maintenance_requests;
create trigger maintenance_requests_log after insert or update of status on public.maintenance_requests
  for each row execute function private.log_maintenance();

create or replace function private.log_alert()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  a public.student_alerts := coalesce(new, old);
  v_what text := 'un estudiante de ' || coalesce(a.group_name, 'otro grupo');
begin
  if tg_op = 'INSERT' then
    perform private.log_activity(a.school_id, auth.uid(), 'Envió la alerta «No ha llegado» de ' || v_what,
      concat_ws(' · ', case when a.place is not null then 'venía de ' || a.place end, case when a.room is not null then 'salón ' || a.room end),
      '#/alerts/missing/' || a.id, null);
  elsif tg_op = 'DELETE' then
    perform private.log_activity(a.school_id, auth.uid(), 'Borró la alerta «No ha llegado» de ' || v_what, null, null, null);
  elsif new.resolved_at is not null and old.resolved_at is null then
    perform private.log_activity(a.school_id, auth.uid(), 'Marcó que apareció ' || v_what, new.found_place, '#/alerts/missing/' || a.id, null);
  elsif new.resolved_at is null and old.resolved_at is not null then
    perform private.log_activity(a.school_id, auth.uid(), 'Reabrió la alerta «No ha llegado» de ' || v_what, null, '#/alerts/missing/' || a.id, null);
  end if;
  return null;
end;
$$;
drop trigger if exists student_alerts_log on public.student_alerts;
create trigger student_alerts_log after insert or update of resolved_at or delete on public.student_alerts
  for each row execute function private.log_alert();

create or replace function private.log_pickup()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_what text := 'un estudiante de ' || coalesce(new.group_name, 'otro grupo');
begin
  if tg_op = 'INSERT' then
    perform private.log_activity(new.school_id, auth.uid(), 'Anotó la salida de ' || v_what,
      case when new.expected_time is not null then 'hora aproximada ' || to_char(new.expected_time, 'HH12:MI AM') end, '#/alerts/pickup/' || new.id, null);
  elsif new.status is distinct from old.status then
    perform private.log_activity(new.school_id, auth.uid(),
      case new.status when 'arrived' then 'Avisó que llegó el encargado de ' when 'on_the_way' then 'Fue al salón por '
        when 'delivered' then 'Entregó a ' when 'cancelled' then 'Canceló la salida de ' else 'Cambió la salida de ' end || v_what,
      null, '#/alerts/pickup/' || new.id, null);
  end if;
  return null;
end;
$$;
drop trigger if exists student_pickups_log on public.student_pickups;
create trigger student_pickups_log after insert or update of status on public.student_pickups
  for each row execute function private.log_pickup();

create or replace function private.log_visit()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.log_activity(new.school_id, auth.uid(), 'Avisó que llegó una visita para ' || coalesce(new.target_name, 'un servicio'),
      concat_ws(' · ', new.visitor_name, case when new.appointment then 'con cita' else 'sin cita' end, 'espera en ' || new.place),
      '#/alerts/visit/' || new.id, new.target_id);
  elsif new.answered_at is distinct from old.answered_at and new.answered_at is not null then
    perform private.log_activity(new.school_id, auth.uid(), 'Respondió a la visita de ' || coalesce(new.visitor_name, 'alguien'),
      concat_ws(' · ', new.answer_place, new.answer_note), '#/alerts/visit/' || new.id, null);
  elsif new.status is distinct from old.status and new.closed_at is not null then
    perform private.log_activity(new.school_id, auth.uid(), 'Cerró la visita de ' || coalesce(new.visitor_name, 'alguien'), null, '#/alerts/visit/' || new.id, null);
  end if;
  return null;
end;
$$;
drop trigger if exists visits_log on public.visits;
create trigger visits_log after insert or update on public.visits for each row execute function private.log_visit();

create or replace function private.log_booking()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_when text := to_char(new.day, 'DD/MM/YYYY') || ' · ' || to_char(new.start_time, 'HH12:MI AM') || ' – ' || to_char(new.end_time, 'HH12:MI AM');
begin
  if tg_op = 'INSERT' then
    perform private.log_activity(new.school_id, auth.uid(), 'Pidió el salón de conferencias: ' || new.purpose, v_when, '#/rooms/' || new.id, null);
  elsif new.status is distinct from old.status then
    perform private.log_activity(new.school_id, auth.uid(),
      case new.status when 'approved' then 'Aprobó la reserva del salón «' when 'rejected' then 'No aprobó la reserva del salón «'
        when 'cancelled' then 'Canceló la reserva del salón «' when 'replaced' then 'Reemplazó la reserva del salón «'
        else 'Cambió la reserva del salón «' end || new.purpose || '»',
      concat_ws(' · ', v_when, new.close_note), '#/rooms/' || new.id, new.created_by);
  end if;
  return null;
end;
$$;
drop trigger if exists room_bookings_log on public.room_bookings;
create trigger room_bookings_log after insert or update of status on public.room_bookings
  for each row execute function private.log_booking();

create or replace function private.log_relief()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.log_activity(new.school_id, auth.uid(), 'Pidió relevo', 'salón ' || new.room, null, null);
  elsif new.taken_at is not null and old.taken_at is null then
    perform private.log_activity(new.school_id, auth.uid(), 'Relevó a ' || new.requested_by_name, 'salón ' || new.room, null, new.requested_by);
  elsif new.cancelled_at is not null and old.cancelled_at is null then
    perform private.log_activity(new.school_id, auth.uid(), 'Canceló su pedido de relevo', null, null, null);
  end if;
  return null;
end;
$$;
drop trigger if exists relief_requests_log on public.relief_requests;
create trigger relief_requests_log after insert or update on public.relief_requests for each row execute function private.log_relief();

create or replace function private.log_closure()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  c public.school_closures := coalesce(new, old);
begin
  perform private.log_activity(c.school_id, auth.uid(),
    case tg_op when 'INSERT' then 'Añadió un día sin clases: ' when 'DELETE' then 'Borró un día sin clases: ' else 'Cambió un día sin clases: ' end || c.name,
    to_char(c.start_date, 'DD/MM/YYYY') || case when c.end_date <> c.start_date then ' al ' || to_char(c.end_date, 'DD/MM/YYYY') else '' end,
    null, null);
  return null;
end;
$$;
drop trigger if exists school_closures_log on public.school_closures;
create trigger school_closures_log after insert or update or delete on public.school_closures for each row execute function private.log_closure();

create or replace function private.log_service()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  s public.school_services := coalesce(new, old);
begin
  perform private.log_activity(s.school_id, auth.uid(),
    case tg_op when 'INSERT' then 'Creó el servicio ' when 'DELETE' then 'Borró el servicio ' else 'Cambió el servicio ' end || s.name,
    case when tg_op = 'UPDATE' then concat_ws(' · ',
      case when new.mode <> old.mode then 'cómo funciona: ' || new.mode end,
      case when new.keep_open <> old.keep_open then case when new.keep_open then 'los turnos siguen abiertos al día siguiente' else 'los turnos se cierran al final del día' end end,
      case when new.active <> old.active then case when new.active then 'activado' else 'desactivado' end end,
      case when new.roles <> old.roles then 'roles: ' || array_to_string(new.roles, ', ') end) end,
    '#/services/' || s.id, null);
  return null;
end;
$$;
drop trigger if exists school_services_log on public.school_services;
create trigger school_services_log after insert or update or delete on public.school_services for each row execute function private.log_service();

-- Changes made in the app by a person (the server's own changes are logged by its functions).
create or replace function private.log_profile()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then return null; end if;
  if (new.full_name, new.position, new.email, new.phone) is distinct from (old.full_name, old.position, old.email, old.phone) then
    perform private.log_activity(new.school_id, v_actor,
      case when v_actor = new.id then 'Actualizó sus datos' else 'Actualizó los datos de ' || new.full_name end, null, null, new.id);
  end if;
  if new.room is distinct from old.room then
    perform private.log_activity(new.school_id, v_actor, 'Cambió su salón', coalesce(new.room, 'sin salón'), null, new.id);
  end if;
  if new.language is distinct from old.language then
    perform private.log_activity(new.school_id, v_actor, 'Cambió el idioma de la app', case new.language when 'en' then 'English' else 'Español' end, null, new.id);
  end if;
  return null;
end;
$$;
drop trigger if exists profiles_log on public.profiles;
create trigger profiles_log after update on public.profiles for each row execute function private.log_profile();

/** Someone's history (what they did and what was done about them), newest first, for the permission «history». */
create or replace function public.activity_history(p_user uuid, p_from timestamptz default null, p_to timestamptz default null)
returns table (id bigint, at timestamptz, actor_id uuid, actor_name text, action text, details text, link text, about boolean)
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
begin
  if not private.can(me, 'history') then raise exception 'No tienes permiso para ver el historial.'; end if;
  if not exists (select 1 from public.profiles p where p.id = p_user and p.school_id = me.school_id) then
    raise exception 'Empleado no encontrado.';
  end if;
  return query
    select l.id, l.at, l.actor_id, l.actor_name, l.action, l.details, l.link, l.actor_id is distinct from p_user
    from public.activity_log l
    where l.school_id = me.school_id and (l.actor_id = p_user or l.subject_id = p_user)
      and l.at >= coalesce(p_from, now() - interval '400 days') and l.at < coalesce(p_to, now() + interval '1 day')
    order by l.at desc
    limit 2000;
end;
$$;
revoke execute on function public.activity_history(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.activity_history(uuid, timestamptz, timestamptz) to authenticated;

-- ---- How long turns last ---------------------------------------------------------------------------------------

create or replace function public.set_service_keep_open(p_id bigint, p_keep boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
begin
  if not private.can(me, 'services') then raise exception 'No tienes permiso para cambiar los servicios.'; end if;
  update public.school_services set keep_open = coalesce(p_keep, false)
  where id = p_id and school_id = me.school_id and keep_open is distinct from coalesce(p_keep, false);
end;
$$;
revoke execute on function public.set_service_keep_open(bigint, boolean) from public, anon;
grant execute on function public.set_service_keep_open(bigint, boolean) to authenticated;

-- ---- Turns kept from earlier days --------------------------------------------------------------------------------

/**
 * The turns still open from before today (p_since: when today started on the phone) in the services this person
 * attends, not yet looked at today. Each with what it is, who asked and when, and its state.
 */
create or replace function public.my_carried_turns(p_since timestamptz)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_since timestamptz := greatest(coalesce(p_since, now() - interval '12 hours'), now() - interval '36 hours');
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'id', r.id, 'service_id', s.id, 'service_name', s.name,
        'service_mode', case when s.mode = 'either' then coalesce(r.flow, 'either') else s.mode end,
        'student_name', r.student_name, 'group_name', r.group_name, 'room', r.room, 'severity', r.severity,
        'status', r.status, 'reason', d.reason, 'note', d.note, 'created_at', r.created_at,
        'created_by_name', r.created_by_name, 'handled_by_name', r.handled_by_name)
      order by s.position, r.created_at)
    from public.service_requests r
    join public.school_services s on s.id = r.service_id
    left join public.service_request_details d on d.request_id = r.id
    where r.school_id = me.school_id and r.status not in ('done', 'cancelled') and r.created_at < v_since
      and private.roles_of(me) && s.roles
      and (r.carried_checked_at is null or r.carried_checked_at < v_since)
  ), '[]'::jsonb);
end;
$$;
revoke execute on function public.my_carried_turns(timestamptz) from public, anon;
grant execute on function public.my_carried_turns(timestamptz) to authenticated;

/** What this person decided about each turn from an earlier day: it goes on (p_keep) or it is closed (p_close). */
create or replace function public.review_carried_turns(p_keep bigint[], p_close bigint[])
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  r public.service_requests;
  v_n int := 0;
begin
  if cardinality(coalesce(p_keep, '{}')) + cardinality(coalesce(p_close, '{}')) > 200 then
    raise exception 'Son demasiados turnos a la vez.';
  end if;
  for r in
    select x.* from public.service_requests x
    join public.school_services s on s.id = x.service_id
    where x.school_id = me.school_id and x.status not in ('done', 'cancelled') and private.roles_of(me) && s.roles
      and (x.id = any(coalesce(p_keep, '{}')) or x.id = any(coalesce(p_close, '{}')))
    for update of x
  loop
    if r.id = any(coalesce(p_close, '{}')) then
      update public.service_requests
      set status = 'cancelled', outcome = 'cancelled', closed_at = now(), closed_by_name = me.full_name, remind_at = null
      where id = r.id;
      update public.service_request_details
      set resolution = coalesce(resolution, 'Se cerró al revisar los turnos de días anteriores.')
      where request_id = r.id;
      perform private.close_notifications('#/turns/' || r.id);
    else
      update public.service_requests set carried_checked_at = now(), carried_checked_by_name = me.full_name where id = r.id;
      perform private.log_activity(me.school_id, me.id,
        format('Siguió con el turno de %s del día anterior en %s', private.turn_label(r), (select s.name from public.school_services s where s.id = r.service_id)),
        'Del ' || to_char(r.created_at at time zone 'America/Puerto_Rico', 'DD/MM/YYYY HH12:MI AM'), '#/turns/' || r.id, null);
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
revoke execute on function public.review_carried_turns(bigint[], bigint[]) from public, anon;
grant execute on function public.review_carried_turns(bigint[], bigint[]) to authenticated;

-- Same as in 20261108000042, with each service's own setting.
create or replace function private.close_school_day()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  s record;
  v_local timestamp;
  v_cutoff timestamptz;
  v_id bigint;
begin
  for s in
    select x.id, coalesce(st.time_zone, 'America/Puerto_Rico') as tz, coalesce(st.day_end, '15:30'::time) as day_end
    from public.schools x
    left join public.school_settings st on st.school_id = x.id
  loop
    v_local := now() at time zone s.tz;
    -- After today's end: everything from today and before; earlier in the day: only what is from previous days.
    v_cutoff := case
      when v_local >= v_local::date + s.day_end then (v_local::date + s.day_end) at time zone s.tz
      else v_local::date::timestamp at time zone s.tz
    end;

    for v_id in
      update public.service_requests x
      set status = case when x.status = 'returning' then 'done' else 'cancelled' end,
        outcome = case when x.status = 'returning' then 'unconfirmed' else 'expired' end,
        closed_at = now(), closed_by_name = 'Hallway', remind_at = null
      where x.school_id = s.id and x.status not in ('done', 'cancelled') and x.created_at < v_cutoff
        -- Services set to keep their turns open (Soporte IT, Trabajo Social…) carry them to the next day.
        and not exists (select 1 from public.school_services svc where svc.id = x.service_id and svc.keep_open)
      returning x.id
    loop
      perform private.close_notifications('#/turns/' || v_id);
    end loop;

    for v_id in
      update public.student_alerts a
      set resolved_at = now(), resolved_by_name = 'Hallway', unconfirmed = true
      where a.school_id = s.id and a.resolved_at is null and a.created_at < v_cutoff
      returning a.id
    loop
      perform private.close_notifications('#/alerts/missing/' || v_id);
    end loop;
  end loop;
end;
$$;

-- Same as in 20261121000055, with keep_open.
create or replace function public.services_overview()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'mode', s.mode, 'arrive_minutes', s.arrive_minutes,
        'roles', to_jsonb(s.roles), 'reasons', to_jsonb(s.reasons), 'active', s.active, 'keep_open', s.keep_open,
        'serves', private.roles_of(me) && s.roles,
        'waiting', (select count(*) from public.service_requests x where x.service_id = s.id and x.status = 'waiting'),
        'staff', (
          select coalesce(jsonb_agg(jsonb_build_object(
              'id', p.id, 'name', p.full_name, 'status', private.staff_status(st),
              'until', case when private.staff_status(st) <> 'available' then st.until end,
              -- Absences around today (the app compares them with the phone's clock): who is out, all day or for a while.
              'absences', (
                select coalesce(jsonb_agg(jsonb_build_object(
                    'start_date', a.start_date, 'end_date', a.end_date, 'partial', a.partial,
                    'start_time', a.start_time, 'end_time', a.end_time) order by a.start_date), '[]'::jsonb)
                from public.absences a
                where a.user_id = p.id and a.status <> 'cancelled'
                  and a.end_date >= current_date - 1 and a.start_date <= current_date + 1))
            order by p.full_name), '[]'::jsonb)
          from public.profiles p
          left join public.service_staff_status st on st.user_id = p.id
          where p.school_id = s.school_id and p.active and private.roles_of(p) && s.roles)
      ) order by s.position, s.name)
    from public.school_services s
    where s.school_id = me.school_id and (s.active or private.can(me, 'services'))
  ), '[]'::jsonb);
end;
$$;
