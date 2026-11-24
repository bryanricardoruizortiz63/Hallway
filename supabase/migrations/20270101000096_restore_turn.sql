-- «Reponer el turno»: a cancelled turn (by anyone, also by the system at the end of the day) goes back to the line, in
-- its place, and stays in its history («Repuso el turno cancelado», who and when) and in the staff history.
--   · Who: whoever attends the service, whoever asked for it and whoever has the student.
--   · When: the same day; in a service whose turns stay open («Siguen abiertos»), up to 7 days later.
--   · Not if the student (or the same request of Soporte IT) already has another turn open in that service.
--   · Why (optional) goes in the turn's chat. The other side hears it.

/**
 * Puts a cancelled turn back in the line. p_reason: why (optional).
 */
create or replace function public.restore_turn(p_id bigint, p_reason text default null)
returns public.service_requests
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  r public.service_requests;
  s public.school_services;
  v_reason text := private.clean_text(p_reason, 300, 'La razón');
  v_tz text := coalesce((select st.time_zone from public.school_settings st where st.school_id = me.school_id), 'America/Puerto_Rico');
  v_serves boolean;
  v_who text;
  v_closed text;
  v_to uuid[];
begin
  select * into r from public.service_requests x where x.id = p_id and x.school_id = me.school_id for update;
  if r.id is null then raise exception 'No se encontró el turno.'; end if;
  select * into s from public.school_services x where x.id = r.service_id;
  v_serves := private.roles_of(me) && s.roles;
  if not (v_serves or r.created_by = me.id or r.teacher_id = me.id) then
    raise exception 'Solo quien lo pidió, quien tiene al estudiante o % pueden reponerlo.', s.name;
  end if;
  if r.status <> 'cancelled' then raise exception 'Este turno no está cancelado.'; end if;
  if not s.active then raise exception '% no está activo.', s.name; end if;
  if (r.created_at at time zone v_tz)::date <> (now() at time zone v_tz)::date
     and not (s.keep_open and r.closed_at > now() - interval '7 days') then
    raise exception 'Solo se reponen los turnos del mismo día%.', case when s.keep_open then ' o de los últimos 7 días' else '' end;
  end if;
  if not v_serves then
    v_closed := private.service_closed(s);
    if v_closed is not null then raise exception '%', v_closed; end if;
  end if;
  if s.mode = 'support' then
    if exists (
      select 1 from public.service_requests x
      join public.service_request_details d on d.request_id = x.id
      join public.service_request_details dr on dr.request_id = r.id
      where x.service_id = s.id and x.id <> r.id and x.created_by = r.created_by and x.status not in ('done', 'cancelled')
        and d.reason is not distinct from dr.reason and lower(x.room) = lower(r.room)
    ) then
      raise exception 'Ya hay otro pedido abierto igual a este en %.', s.name;
    end if;
  elsif exists (
    select 1 from public.service_requests x
    where x.service_id = s.id and x.id <> r.id and x.student_key = r.student_key and x.group_name = r.group_name
      and x.status not in ('done', 'cancelled')
  ) then
    raise exception '% (%) ya tiene otro turno abierto en %.', r.student_name, r.group_name, s.name;
  end if;

  update public.service_requests
  set status = 'waiting', outcome = null, closed_at = null, closed_by_name = null,
    called_at = null, sent_at = null, due_at = null, late_at = null, arrived_at = null, on_the_way_at = null,
    returning_at = null, return_late_at = null, return_check_at = null, remind_at = null, reminders = 0,
    handled_by = null, handled_by_name = null, out_of_order = false, received_at = null, received_by_name = null,
    flow = null
  where id = r.id
  returning * into r;

  if v_reason is not null then
    insert into public.service_request_messages
      (request_id, school_id, service_id, requester_id, student_name, turn_day, author_id, author_name, author_side, kind, body)
    values (r.id, r.school_id, r.service_id, r.created_by, r.student_name, (r.created_at at time zone v_tz)::date,
      me.id, me.full_name, case when v_serves then 'service' else 'teacher' end, 'message', 'Repuso el turno: ' || v_reason);
  end if;

  v_who := case when s.mode = 'support'
    then coalesce((select d.reason from public.service_request_details d where d.request_id = r.id), 'el pedido')
    else format('%s (%s)', r.student_name, r.group_name) end;
  -- The other side: the service hears it as a new turn; the teacher, that it's back.
  v_to := case when v_serves then private.uuid_minus(array_remove(array[r.created_by, r.teacher_id], null), array[me.id])
    else private.service_staff_ids(s.id, me.id) end;
  perform private.close_notifications('#/turns/' || r.id);
  perform private.notify_tagged(v_to,
    format('📋 Turno repuesto: %s', v_who),
    format('%s · lo repuso %s%s.', s.name, me.full_name, coalesce(': «' || left(v_reason, 200) || '»', '')),
    '#/turns/' || r.id, 'turn-' || r.id, not v_serves);
  return r;
end;
$$;
revoke execute on function public.restore_turn(bigint, text) from public, anon;
grant execute on function public.restore_turn(bigint, text) to authenticated;

-- The turn's changes: «Repuso el turno cancelado» (as in 20261208000072 otherwise).
create or replace function private.turn_event()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_name text := (select p.full_name from public.profiles p where p.id = auth.uid());
  v_service text := (select s.name from public.school_services s where s.id = new.service_id);
  v_support boolean := (select s.mode = 'support' from public.school_services s where s.id = new.service_id);
  v_kind text;
  v_what text;
begin
  if tg_op = 'INSERT' then
    perform private.add_turn_event(new, coalesce(new.created_by, v_actor), coalesce(new.created_by_name, v_name),
      'created', case when new.status = 'arrived' then 'Anotó que llegó sin turno' else 'Pidió el turno' end);
    return null;
  end if;

  if new.status is distinct from old.status then
    v_kind := new.status;
    v_what := case new.status
      when 'called' then 'Lo llamó a ' || v_service
      when 'sent' then 'Marcó que salió del salón'
      when 'arrived' then 'Marcó que llegó a ' || v_service
      when 'on_the_way' then case when v_support then 'Fue en camino' else 'Fue al salón' end
      when 'returning' then 'Lo envió de regreso al salón'
      when 'done' then 'Cerró el turno: ' || case new.outcome
        when 'returned' then 'regresó al salón' when 'picked_up' then 'lo recogieron'
        when 'referred' then case when v_support then 'necesita seguimiento' else 'referido / con seguimiento' end
        when 'attended' then case when v_support then 'resuelto' else 'atendido' end
        when 'unconfirmed' then 'regreso sin confirmar' else 'terminado' end
      when 'cancelled' then case when new.outcome = 'expired'
        then 'Lo cerró el sistema: terminó el horario escolar y no se tomó el turno' else 'Canceló el turno' end
      when 'waiting' then case when old.status = 'cancelled' then 'Repuso el turno cancelado' else 'Lo devolvió a la fila' end
      else 'Cambió el estado' end;
    if new.status in ('done', 'cancelled') then
      -- Closures done through the server (end of the day) carry their own name.
      if new.outcome = 'expired' or (v_actor is null and coalesce(new.closed_by_name, 'Sistema') = 'Sistema') then
        v_actor := null;
        v_name := 'Sistema';
      elsif v_name is null then
        v_name := new.closed_by_name;
      end if;
    end if;
    perform private.add_turn_event(new, v_actor, coalesce(v_name, 'Sistema'), v_kind, v_what);
  end if;

  if new.room is distinct from old.room then
    perform private.add_turn_event(new, auth.uid(),
      coalesce((select p.full_name from public.profiles p where p.id = auth.uid()), 'Sistema'), 'room',
      format('Cambió el salón: %s → %s', coalesce(old.room, '—'), coalesce(new.room, '—')));
  end if;
  if new.severity is distinct from old.severity then
    perform private.add_turn_event(new, auth.uid(),
      coalesce((select p.full_name from public.profiles p where p.id = auth.uid()), 'Sistema'), 'severity',
      format('Cambió la gravedad: %s → %s',
        (array['Baja', 'Media', 'Alta', 'Urgente'])[old.severity], (array['Baja', 'Media', 'Alta', 'Urgente'])[new.severity]));
  end if;
  return null;
end;
$$;

-- The staff history: «Repuso el turno de … en …» (as in 20261208000072 otherwise).
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
    perform private.log_record(new.school_id, auth.uid(), v_action,
      concat_ws(' · ', (select d.reason from public.service_request_details d where d.request_id = new.id),
        case when new.room is not null then 'salón ' || new.room end), v_link, private.turn_record(new));
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
      then format('El sistema cerró el turno de %s en %s: terminó el horario escolar', v_what, v_service)
      else format('Canceló el turno de %s en %s', v_what, v_service) end
    when 'waiting' then case when old.status = 'cancelled' then format('Repuso el turno de %s en %s', v_what, v_service) end
    else null end;
  if v_action is null then return null; end if;
  perform private.log_record(new.school_id, auth.uid(), v_action,
    case new.outcome
      when 'returned' then 'Regresó al salón.' when 'picked_up' then 'Lo recogieron.' when 'referred' then 'Referido / con seguimiento.'
      when 'attended' then 'Atendido.' when 'expired' then 'Terminó el horario escolar y el turno no se tomó.'
      when 'unconfirmed' then 'Regreso sin confirmar.' else null end,
    v_link, private.turn_record(new));
  return null;
end;
$$;
