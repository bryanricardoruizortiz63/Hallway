-- What the turns' Excel and PDF were missing:
--   · «Otro» as the reason: what was written (the note: when the reason is «Otro», the app asks «¿Cuál es el motivo?»
--     there). Only for «Otro»: the other notes stay out of the panel and the Excel, as before.
--   · A cancelled turn: why (what was written when cancelling it) and who; «Sistema» when the system closed it.
-- Same as before otherwise: service_turns as in 20261228000092 and search_turns as in 20261222000086.

/** The reason «Otro» (or «Other»), in any letter case. */
create or replace function private.is_other_reason(p_reason text)
returns boolean
language sql immutable set search_path = ''
as $$
  select lower(btrim(coalesce(p_reason, ''))) in ('otro', 'otra', 'otros', 'otras', 'other');
$$;

/** Why a turn was cancelled: the last thing written when cancelling it. */
create or replace function private.turn_cancel_reason(p_request bigint)
returns text
language sql stable set search_path = ''
as $$
  select m.body from public.service_request_messages m
  where m.request_id = p_request and m.kind = 'cancel'
  order by m.id desc limit 1;
$$;

drop function if exists public.service_turns(bigint, timestamptz, timestamptz);
create or replace function public.service_turns(p_service_id bigint, p_from timestamptz, p_to timestamptz)
returns table (id bigint, service_id bigint, student_name text, student_key text, group_name text, severity smallint,
  status text, outcome text, reason text, created_by_name text, handled_by uuid, handled_by_name text, out_of_order boolean,
  created_at timestamptz, called_at timestamptz, sent_at timestamptz, arrived_at timestamptz, on_the_way_at timestamptz,
  returning_at timestamptz, closed_at timestamptz, late_at timestamptz, room text, resolution text,
  reason_detail text, closed_by_name text, cancel_reason text)
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_all boolean := private.sees_whole_service(me);
  v_owners uuid[] := private.service_data_owners(p_service_id, me);
begin
  if not exists (select 1 from public.school_services s where s.id = p_service_id and s.school_id = me.school_id) then
    raise exception 'No se encontró el servicio.';
  end if;
  if not (private.serves(p_service_id) or v_all) then
    raise exception 'Solo quien atiende este servicio y la dirección ven su panel.';
  end if;
  return query
    select r.id, r.service_id, r.student_name, r.student_key, r.group_name, r.severity, r.status,
      r.outcome, d.reason,
      r.created_by_name, r.handled_by, r.handled_by_name, r.out_of_order, r.created_at, r.called_at, r.sent_at, r.arrived_at,
      r.on_the_way_at, r.returning_at, r.closed_at, r.late_at, r.room, d.resolution,
      case when private.is_other_reason(d.reason) then d.note end,
      r.closed_by_name,
      case when r.status = 'cancelled' then private.turn_cancel_reason(r.id) end
    from public.service_requests r
    left join public.service_request_details d on d.request_id = r.id
    where r.service_id = p_service_id and r.created_at >= p_from and r.created_at < p_to
      and (v_all or r.handled_by = any(v_owners))
    order by r.id;
end;
$$;
revoke execute on function public.service_turns(bigint, timestamptz, timestamptz) from public, anon;
grant execute on function public.service_turns(bigint, timestamptz, timestamptz) to authenticated;

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
        'status', r.status, 'outcome', private.turn_outcome_shown(r.outcome, k.ok), 'reason', case when k.ok then d.reason end,
        'reason_detail', case when k.ok and private.is_other_reason(d.reason) then d.note end,
        'cancel_reason', case when k.ok and r.status = 'cancelled' then private.turn_cancel_reason(r.id) end,
        'created_at', r.created_at, 'closed_at', r.closed_at, 'closed_by_name', r.closed_by_name,
        'created_by_name', r.created_by_name, 'handled_by_name', r.handled_by_name) as x
      from public.service_requests r
      join public.school_services s on s.id = r.service_id
      cross join lateral (select private.turn_details_ok(r.service_id, r.created_by) as ok) k
      left join public.service_request_details d on d.request_id = r.id
      where r.school_id = me.school_id
        and (p_from is null or (r.created_at at time zone v_tz)::date >= p_from)
        and (p_to is null or (r.created_at at time zone v_tz)::date <= p_to)
        and (p_service is null or r.service_id = p_service)
        and (v_group is null or r.group_name = v_group)
        and (v_name is null or r.student_name ilike '%' || v_name || '%' or r.created_by_name ilike '%' || v_name || '%'
             or (k.ok and d.reason ilike '%' || v_name || '%'))
      order by r.created_at desc
      limit 500
    ) t(x)
  ), '[]'::jsonb);
end;
$$;
