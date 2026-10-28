-- Soporte IT: quien atiende puede avisarle al maestro que recibió su pedido («Recibido»), sin ir todavía en camino.
-- Al maestro le llega quién lo recibió y qué número de turno tiene; deja de sonar el aviso urgente del pedido.
-- La app le muestra al maestro su número de turno (position) y cuánto lleva esperando.

alter table public.service_requests add column received_at timestamptz, add column received_by_name text;

create or replace view public.service_requests_v with (security_invoker = true) as
  select r.id, r.school_id, r.service_id, r.student_id, r.student_name, r.student_key, r.group_name, r.room,
    r.severity, r.status, r.outcome, r.teacher_id, r.teacher_name, r.created_by, r.created_by_name, r.created_at,
    r.handled_by, r.handled_by_name, r.out_of_order, r.called_at, r.sent_at, r.due_at, r.late_at, r.arrived_at,
    r.on_the_way_at, r.returning_at, r.closed_at, r.closed_by_name,
    s.name as service_name, s.mode as service_mode, d.reason, d.note,
    case when r.status = 'waiting' then private.turn_level(r.severity, r.created_at) end as level,
    private.turn_position(r.id) as position,
    r.return_late_at,
    d.resolution,
    r.return_check_at,
    r.received_at,
    r.received_by_name
  from public.service_requests r
  join public.school_services s on s.id = r.service_id
  left join public.service_request_details d on d.request_id = r.id;

/** «Recibido»: someone of the support service tells whoever asked that they have it. Once per request. */
create or replace function public.receive_support_request(p_id bigint)
returns public.service_requests
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  r public.service_requests;
  s public.school_services;
  v_what text;
  v_position int;
begin
  select * into r from public.service_requests x where x.id = p_id and x.school_id = me.school_id for update;
  if r.id is null then raise exception 'No se encontró el pedido.'; end if;
  select * into s from public.school_services x where x.id = r.service_id;
  if s.mode <> 'support' or not me.role = any(s.roles) then raise exception 'Lo marca %.', s.name; end if;
  if r.status <> 'waiting' then raise exception 'Este pedido ya no está en espera.'; end if;
  if r.received_at is not null then
    raise exception 'Ya lo marcó %.', coalesce(r.received_by_name, 'otra persona');
  end if;
  update public.service_requests set received_at = now(), received_by_name = me.full_name
  where id = r.id returning * into r;
  v_position := private.turn_position(r.id);
  v_what := coalesce((select d.reason from public.service_request_details d where d.request_id = r.id), 'tu pedido');
  -- The urgent notice stops ringing for the service.
  perform private.close_notifications('#/turns/' || r.id);
  perform private.notify_tagged(array_remove(array[r.created_by], me.id),
    format('📋 %s recibió tu pedido', s.name),
    concat_ws(' · ', v_what || coalesce(' (' || r.room || ')', ''), 'lo recibió ' || me.full_name,
      case when v_position is not null then format('vas #%s en la fila', v_position) end) || '.',
    '#/turns/' || r.id, 'turn-' || r.id, false);
  return r;
end;
$$;

revoke execute on function public.receive_support_request(bigint) from public, anon;
grant execute on function public.receive_support_request(bigint) to authenticated;
