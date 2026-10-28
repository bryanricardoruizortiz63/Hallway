-- Administrar las alertas de «No ha llegado»: la dirección (permiso `settings`; la cuenta de Administración lo tiene
-- todo) puede cambiar el estado (apareció, sin confirmar, reabrir), corregir de dónde venía, el salón y la nota, y
-- borrar una alerta puesta por error, que así no cuenta en los reportes. Cada cambio queda con quién y cuándo.

alter table public.student_alerts add column edited_at timestamptz, add column edited_by_name text;

create or replace view public.student_alerts_v with (security_invoker = true) as
select a.id, a.school_id, a.student_id, a.group_name, a.place, a.room, a.note, a.audience, a.created_by,
  a.created_by_name, a.created_at, a.resolved_at, a.resolved_by, a.resolved_by_name, a.found_place,
  s.name as student_name, a.turn_id, a.unconfirmed, a.edited_at, a.edited_by_name
from public.student_alerts a
left join public.students s on s.id = a.student_id;

/**
 * p_action:
 *   found        apareció (p_found_place: dónde estaba); si seguía abierta, avisa como «Apareció / está conmigo»
 *   unconfirmed  cerrada sin confirmar dónde estaba
 *   reopen       otra vez «No ha llegado»; solo el mismo día escolar, antes de la hora de salida
 *   edit         de dónde venía (p_place), el salón (p_room) y la nota (p_note)
 *   delete       se borra; devuelve null
 */
create or replace function public.manage_student_alert(
  p_id bigint, p_action text, p_found_place text default null, p_place text default null,
  p_room text default null, p_note text default null
)
returns public.student_alerts
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  a public.student_alerts;
  v_link text := '#/alerts/missing/' || p_id;
  v_local timestamp;
  st record;
begin
  if not private.can(me, 'settings') then raise exception 'Solo la dirección puede cambiar las alertas.'; end if;
  select * into a from public.student_alerts x where x.id = p_id and x.school_id = me.school_id for update;
  if a.id is null then raise exception 'No se encontró la alerta.'; end if;

  if p_action = 'found' then
    if a.resolved_at is null then
      return public.resolve_student_alert(p_id, p_found_place);
    end if;
    update public.student_alerts
    set found_place = private.clean_text(p_found_place, 120, 'El lugar'), unconfirmed = false,
      resolved_by = me.id, resolved_by_name = me.full_name, edited_at = now(), edited_by_name = me.full_name
    where id = a.id returning * into a;

  elsif p_action = 'unconfirmed' then
    update public.student_alerts
    set resolved_at = coalesce(resolved_at, now()), resolved_by = me.id, resolved_by_name = me.full_name,
      found_place = null, unconfirmed = true, edited_at = now(), edited_by_name = me.full_name
    where id = a.id returning * into a;
    perform private.close_notifications(v_link);

  elsif p_action = 'reopen' then
    if a.resolved_at is null then raise exception 'Esta alerta ya está abierta.'; end if;
    select coalesce(s.time_zone, 'America/Puerto_Rico') as tz, coalesce(s.day_end, '15:30'::time) as day_end
    into st from (select 1) one left join public.school_settings s on s.school_id = me.school_id;
    v_local := now() at time zone st.tz;
    -- At the end of the day private.close_school_day would close it again.
    if (a.created_at at time zone st.tz)::date <> v_local::date or v_local >= v_local::date + st.day_end then
      raise exception 'Solo se puede reabrir una alerta de hoy, antes de la hora de salida.';
    end if;
    update public.student_alerts
    set resolved_at = null, resolved_by = null, resolved_by_name = null, found_place = null, unconfirmed = false,
      edited_at = now(), edited_by_name = me.full_name
    where id = a.id returning * into a;

  elsif p_action = 'edit' then
    update public.student_alerts
    set place = private.clean_text(p_place, 120, 'De dónde venía'),
      room = private.clean_text(regexp_replace(coalesce(p_room, ''), '\s+', ' ', 'g'), 40, 'El salón'),
      note = private.clean_text(p_note, 500, 'La nota'),
      edited_at = now(), edited_by_name = me.full_name
    where id = a.id returning * into a;

  elsif p_action = 'delete' then
    perform private.close_notifications(v_link);
    delete from public.student_alerts where id = a.id;
    return null;

  else
    raise exception 'Acción no válida.';
  end if;
  return a;
end;
$$;

revoke execute on function public.manage_student_alert(bigint, text, text, text, text, text) from public, anon;
grant execute on function public.manage_student_alert(bigint, text, text, text, text, text) to authenticated;
