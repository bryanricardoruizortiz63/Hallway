-- A turn closed by the system says why without blaming anyone: «Lo cerró el sistema: terminó el horario escolar y no se
-- tomó el turno» (it said «nadie lo atendió»). The same in the turn's changes, its record and the staff history, also
-- for what was already saved.

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
      when 'waiting' then 'Lo devolvió a la fila'
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

create or replace function private.turn_record(r public.service_requests)
returns text
language sql stable security definer set search_path = ''
as $$
  select nullif(concat_ws(' · ',
    case when r.student_name is not null then 'Estudiante: ' || r.student_name || coalesce(' (' || r.group_name || ')', '') end,
    'Servicio: ' || s.name,
    'Motivo: ' || d.reason,
    'Nota: ' || d.note,
    'Gravedad: ' || (array['Baja', 'Media', 'Alta', 'Urgente'])[r.severity],
    'Salón: ' || r.room,
    'Pidió: ' || r.created_by_name,
    'Atendió: ' || r.handled_by_name,
    'Resultado: ' || case r.outcome
      when 'returned' then 'regresó al salón' when 'picked_up' then 'lo recogieron' when 'referred' then 'referido / con seguimiento'
      when 'attended' then 'atendido' when 'expired' then 'no se tomó (terminó el horario escolar)' when 'unconfirmed' then 'regreso sin confirmar'
      when 'cancelled' then 'cancelado' else null end,
    case
      when r.outcome = 'expired' then 'Lo cerró: el sistema'
      when r.status = 'cancelled' then 'Lo canceló: ' || coalesce(r.closed_by_name, 'Sistema')
      when r.status = 'done' then 'Lo cerró: ' || coalesce(r.closed_by_name, 'Sistema')
    end), '')
  from public.school_services s
  left join public.service_request_details d on d.request_id = r.id
  where s.id = r.service_id
$$;

-- Same as in 20261130000064, with the new words for the system's closures.
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

update public.service_request_events set what = 'Lo cerró el sistema: terminó el horario escolar y no se tomó el turno' where what = 'Lo cerró el sistema: nadie lo atendió antes del final del día';
update public.activity_log set details = 'Terminó el horario escolar y el turno no se tomó.'
  where details = 'Nadie lo atendió antes del final del día.';
update public.activity_log
  set action = regexp_replace(action, '^Cerró sin atender el turno de (.+) en (.+)$', 'El sistema cerró el turno de \1 en \2: terminó el horario escolar')
  where action like 'Cerró sin atender el turno de %';
update public.activity_log set record = replace(record, 'Resultado: sin atender al final del día', 'Resultado: no se tomó (terminó el horario escolar)')
  where record like '%sin atender al final del día%';
