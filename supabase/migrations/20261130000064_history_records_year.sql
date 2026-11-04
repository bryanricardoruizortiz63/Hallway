-- Historial del personal:
--   * Turns keep a record of the student and the turn (name, group, reason, note, severity, room, how it ended).
--     Only the school's Admin and Director(a) see those records; whoever has the «Historial del personal»
--     permission sees the history without them.
--   * The history lasts one school year (August 1 to June 30): on July 1 the year that ended is deleted. Admins and
--     directors are reminded to download it 1 month, 2 weeks, 1 week and 1 day before June 30.
--   * activity_history_all: the whole school's history of a period, for the Excel download.

alter table public.activity_log add column if not exists record text check (char_length(record) <= 2000);

/** The school's Admin (the account or the role) and Director(a): they see the history with the students' records. */
create or replace function private.history_full(p public.profiles)
returns boolean
language sql stable set search_path = ''
as $$
  select private.is_admin(p) or 'director' = any(private.roles_of(p))
$$;

/** One line of the history with a record (only Admin and Director(a) see the record). */
create or replace function private.log_record(
  p_school uuid, p_actor uuid, p_action text, p_details text, p_link text, p_record text
)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_school is null or p_action is null then return; end if;
  insert into public.activity_log (school_id, actor_id, actor_name, action, details, link, record)
  values (p_school, p_actor,
    coalesce((select p.full_name from public.profiles p where p.id = p_actor), 'Hallway'),
    left(p_action, 200), left(p_details, 1000), left(p_link, 200), left(p_record, 2000));
end;
$$;
revoke execute on function private.log_record(uuid, uuid, text, text, text, text) from public, anon, authenticated;

/** The turn's record: who the student is and what the turn was. */
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
      when 'attended' then 'atendido' when 'expired' then 'sin atender al final del día' when 'unconfirmed' then 'regreso sin confirmar'
      when 'cancelled' then 'cancelado' else null end), '')
  from public.school_services s
  left join public.service_request_details d on d.request_id = r.id
  where s.id = r.service_id
$$;

-- Same as in 20261125000059, with the record.
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
      then format('Cerró sin atender el turno de %s en %s', v_what, v_service)
      else format('Canceló el turno de %s en %s', v_what, v_service) end
    else null end;
  if v_action is null then return null; end if;
  perform private.log_record(new.school_id, auth.uid(), v_action,
    case new.outcome
      when 'returned' then 'Regresó al salón.' when 'picked_up' then 'Lo recogieron.' when 'referred' then 'Referido / con seguimiento.'
      when 'attended' then 'Atendido.' when 'expired' then 'Nadie lo atendió antes del final del día.'
      when 'unconfirmed' then 'Regreso sin confirmar.' else null end,
    v_link, private.turn_record(new));
  return null;
end;
$$;

-- The history now also says whether it comes with records; the records only for Admin and Director(a).
drop function if exists public.activity_history(uuid, timestamptz, timestamptz);
create function public.activity_history(p_user uuid, p_from timestamptz default null, p_to timestamptz default null)
returns table (id bigint, at timestamptz, actor_id uuid, actor_name text, action text, details text, link text, about boolean, record text)
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_full boolean := private.history_full(me);
begin
  if not private.can(me, 'history') then raise exception 'No tienes permiso para ver el historial.'; end if;
  if not exists (select 1 from public.profiles p where p.id = p_user and p.school_id = me.school_id) then
    raise exception 'Empleado no encontrado.';
  end if;
  return query
    select l.id, l.at, l.actor_id, l.actor_name, l.action, l.details, l.link, l.actor_id is distinct from p_user,
      case when v_full then l.record end
    from public.activity_log l
    where l.school_id = me.school_id and (l.actor_id = p_user or l.subject_id = p_user)
      and l.at >= coalesce(p_from, now() - interval '400 days') and l.at < coalesce(p_to, now() + interval '1 day')
    order by l.at desc
    limit 2000;
end;
$$;
revoke execute on function public.activity_history(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.activity_history(uuid, timestamptz, timestamptz) to authenticated;

/** The whole school's history of a period (for the Excel), oldest first. Records only for Admin and Director(a). */
create or replace function public.activity_history_all(p_from timestamptz, p_to timestamptz)
returns table (id bigint, at timestamptz, actor_id uuid, actor_name text, action text, details text, subject_name text, record text)
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_full boolean := private.history_full(me);
begin
  if not private.can(me, 'history') then raise exception 'No tienes permiso para ver el historial.'; end if;
  return query
    select l.id, l.at, l.actor_id, l.actor_name, l.action, l.details, s.full_name, case when v_full then l.record end
    from public.activity_log l
    left join public.profiles s on s.id = l.subject_id
    where l.school_id = me.school_id and l.at >= p_from and l.at < p_to
    order by l.at
    limit 50000;
end;
$$;
revoke execute on function public.activity_history_all(timestamptz, timestamptz) from public, anon;
grant execute on function public.activity_history_all(timestamptz, timestamptz) to authenticated;

-- ---- One school year ------------------------------------------------------------------------------------------

/** July 1 of the school year that is running now, in Puerto Rico (everything before it belongs to an ended year). */
create or replace function private.history_year_cut()
returns timestamptz
language sql stable set search_path = ''
as $$
  select make_timestamptz(
    extract(year from now() at time zone 'America/Puerto_Rico')::int
      - case when extract(month from now() at time zone 'America/Puerto_Rico') < 7 then 1 else 0 end,
    7, 1, 0, 0, 0, 'America/Puerto_Rico')
$$;

/**
 * Hourly: the reminders to download the history (from 8 a. m. in Puerto Rico, once each), and on July 1 the history
 * of the school year that ended is deleted.
 */
create or replace function private.history_year_job()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_now timestamp := now() at time zone 'America/Puerto_Rico';
  v_end date := make_date(extract(year from v_now)::int, 6, 30);
  v_left text;
  v_tag text;
  s record;
begin
  delete from public.activity_log where at < private.history_year_cut();

  if extract(hour from v_now) < 8 then return; end if;
  v_left := case v_now::date
    when v_end - 30 then 'Falta 1 mes' when v_end - 14 then 'Faltan 2 semanas' when v_end - 7 then 'Falta 1 semana'
    when v_end - 1 then 'Falta 1 día'
    else null end;
  if v_left is null then return; end if;
  v_tag := 'history-year-' || to_char(v_now, 'YYYY-MM-DD');
  for s in select x.id from public.schools x where x.active loop
    if exists (select 1 from public.notifications n join public.profiles p on p.id = n.user_id
               where p.school_id = s.id and n.tag = v_tag) then
      continue;
    end if;
    perform private.notify_tagged(
      array(select p.id from public.profiles p where p.school_id = s.id and p.active and private.history_full(p)),
      '📥 Descarga el historial del año escolar',
      format('%s: el 30 de junio termina el año escolar y el 1 de julio se borra el historial del personal y el récord de los turnos. Descárgalo en Más › Historial del personal.', v_left),
      '#/history', v_tag, false);
  end loop;
end;
$$;
revoke execute on function private.history_year_job() from public, anon, authenticated;

select cron.unschedule('hallway-history-year') where exists (select 1 from cron.job where jobname = 'hallway-history-year');
select cron.schedule('hallway-history-year', '23 * * * *', $job$select private.history_year_job()$job$);
