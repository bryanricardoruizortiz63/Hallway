-- Every change of a turn says who made it:
--   * service_request_events: one line per change (asked, called, sent, arrived, on the way, back to class, closed,
--     cancelled, room or severity changed), with who did it and when. Whoever can see the turn sees its lines.
--   * When nobody made it (the end of the day closed it because nobody attended it), it says «Sistema».
--   * The turns' record in the staff history also says who closed or cancelled it.
-- The lines go with the turn (and with the school year that is deleted on July 1).

create table if not exists public.service_request_events (
  id bigint generated always as identity primary key,
  request_id bigint not null references public.service_requests(id) on delete cascade,
  school_id uuid not null references public.schools(id) on delete cascade,
  at timestamptz not null default now(),
  actor_id uuid references public.profiles(id) on delete set null,
  actor_name text not null,
  kind text not null,
  what text not null check (char_length(what) <= 300)
);
create index if not exists service_request_events_request on public.service_request_events (request_id, at);

alter table public.service_request_events enable row level security;
drop policy if exists "events of the turns one sees" on public.service_request_events;
create policy "events of the turns one sees" on public.service_request_events
  for select to authenticated
  using (exists (select 1 from public.service_requests r where r.id = request_id));
revoke all on public.service_request_events from anon;
grant select on public.service_request_events to authenticated;

/** The system's closures said «Hallway»: from now on, «Sistema». */
create or replace function private.system_name()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.closed_by_name = 'Hallway' then new.closed_by_name := 'Sistema'; end if;
  return new;
end;
$$;
drop trigger if exists service_requests_system_name on public.service_requests;
create trigger service_requests_system_name before insert or update of closed_by_name on public.service_requests
  for each row execute function private.system_name();

/** One line per change of the turn, with who made it (nobody: «Sistema»). */
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
        then 'Lo cerró el sistema: nadie lo atendió antes del final del día' else 'Canceló el turno' end
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
revoke execute on function private.turn_event() from public, anon, authenticated;

create or replace function private.add_turn_event(r public.service_requests, p_actor uuid, p_name text, p_kind text, p_what text)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.service_request_events (request_id, school_id, actor_id, actor_name, kind, what)
  values (r.id, r.school_id, p_actor, left(coalesce(p_name, 'Sistema'), 120), p_kind, left(p_what, 300))
$$;
revoke execute on function private.add_turn_event(public.service_requests, uuid, text, text, text) from public, anon, authenticated;

drop trigger if exists service_requests_events on public.service_requests;
create trigger service_requests_events after insert or update of status, room, severity on public.service_requests
  for each row execute function private.turn_event();

-- The turns that already exist: their lines from what each one kept (who asked, called, went and closed it).
update public.service_requests set closed_by_name = 'Sistema' where closed_by_name = 'Hallway';

insert into public.service_request_events (request_id, school_id, at, actor_id, actor_name, kind, what)
select r.id, r.school_id, e.at, e.actor_id,
  -- Who marked «llegó» or «regresa» wasn't kept before: it says so instead of guessing.
  coalesce(e.actor_name, case when e.kind in ('arrived', 'returning') then 'Sin registrar' else 'Sistema' end), e.kind, e.what
from public.service_requests r
join public.school_services s on s.id = r.service_id
cross join lateral (values
  (r.created_at, r.created_by, r.created_by_name, 'created', 'Pidió el turno'),
  (r.called_at, r.handled_by, r.handled_by_name, 'called', 'Lo llamó a ' || s.name),
  (r.sent_at, r.teacher_id, r.teacher_name, 'sent', 'Marcó que salió del salón'),
  (r.arrived_at, null::uuid, null::text, 'arrived', 'Llegó a ' || s.name),
  (r.on_the_way_at, r.handled_by, r.handled_by_name, 'on_the_way', case when s.mode = 'support' then 'Fue en camino' else 'Fue al salón' end),
  (r.returning_at, null::uuid, null::text, 'returning', 'Lo envió de regreso al salón'),
  (case when r.status in ('done', 'cancelled') then r.closed_at end, null::uuid, r.closed_by_name, r.status,
    case
      when r.outcome = 'expired' then 'Lo cerró el sistema: nadie lo atendió antes del final del día'
      when r.status = 'cancelled' then 'Canceló el turno'
      else 'Cerró el turno: ' || case r.outcome
        when 'returned' then 'regresó al salón' when 'picked_up' then 'lo recogieron'
        when 'referred' then case when s.mode = 'support' then 'necesita seguimiento' else 'referido / con seguimiento' end
        when 'attended' then case when s.mode = 'support' then 'resuelto' else 'atendido' end
        when 'unconfirmed' then 'regreso sin confirmar' else 'terminado' end
    end)
) as e(at, actor_id, actor_name, kind, what)
where e.at is not null
  and not exists (select 1 from public.service_request_events x where x.request_id = r.id);

-- ---- The staff history: «Sistema» instead of «Hallway», and who closed the turn in its record -------------------

update public.activity_log set actor_name = 'Sistema' where actor_name = 'Hallway' and actor_id is null;

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
    coalesce((select p.full_name from public.profiles p where p.id = p_actor), 'Sistema'),
    left(p_action, 200), left(p_details, 1000), left(p_link, 200), left(p_record, 2000));
end;
$$;
revoke execute on function private.log_record(uuid, uuid, text, text, text, text) from public, anon, authenticated;

-- Same as in 20261130000064, with who closed or cancelled it.
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

-- «Buscar turnos»: who closed or cancelled it (same as in 20261205000069, with closed_by_name).
create or replace function public.search_turns(p_from date, p_to date, p_name text, p_service bigint, p_group text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_group text := nullif(btrim(coalesce(p_group, '')), '');
  v_tz text := coalesce((select st.time_zone from public.school_settings st where st.school_id = me.school_id), 'America/Puerto_Rico');
begin
  if not (private.can(me, 'turn_search') or private.history_full(me)) then
    raise exception 'No tienes permiso para buscar turnos.';
  end if;
  return coalesce((
    select jsonb_agg(x order by x->>'created_at' desc)
    from (
      select jsonb_build_object(
        'id', r.id, 'service_id', s.id, 'service_name', s.name, 'service_mode', s.mode,
        'student_name', r.student_name, 'group_name', r.group_name, 'room', r.room, 'severity', r.severity,
        'status', r.status, 'outcome', r.outcome, 'reason', d.reason,
        'created_at', r.created_at, 'closed_at', r.closed_at, 'closed_by_name', r.closed_by_name,
        'created_by_name', r.created_by_name, 'handled_by_name', r.handled_by_name) as x
      from public.service_requests r
      join public.school_services s on s.id = r.service_id
      left join public.service_request_details d on d.request_id = r.id
      where r.school_id = me.school_id
        and (p_from is null or (r.created_at at time zone v_tz)::date >= p_from)
        and (p_to is null or (r.created_at at time zone v_tz)::date <= p_to)
        and (p_service is null or r.service_id = p_service)
        and (v_group is null or r.group_name = v_group)
        and (v_name is null or r.student_name ilike '%' || v_name || '%' or r.created_by_name ilike '%' || v_name || '%'
             or d.reason ilike '%' || v_name || '%')
      order by r.created_at desc
      limit 500
    ) t(x)
  ), '[]'::jsonb);
end;
$$;
revoke execute on function public.search_turns(date, date, text, bigint, text) from public, anon;
grant execute on function public.search_turns(date, date, text, bigint, text) to authenticated;
