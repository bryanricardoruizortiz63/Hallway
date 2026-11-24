-- Datos y reportes de los servicios: each person sees what they attended.
-- 1. Whoever attends a service (Enfermería, Trabajo Social…) sees in its panel only the turns they attended, plus those
--    of the colleagues who allowed them. The dirección («Datos y reportes») and whoever sees every turn's detail still
--    see the whole service. The live queue doesn't change: everyone who attends the service still sees it.
-- 2. Asking a colleague: a person asks (with a reason), the colleague gets a notice and allows or refuses; either of the
--    two can end it whenever they want. Everything stays in the history.
-- 3. When the service's hours end, each person who attended turns that day gets a notice with their own day, which
--    opens their data of that day.

create table if not exists public.service_data_access (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools (id) on delete cascade,
  service_id bigint not null references public.school_services (id) on delete cascade,
  requester_id uuid not null references public.profiles (id) on delete cascade,
  requester_name text not null,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  owner_name text not null,
  reason text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'ended')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  ended_at timestamptz,
  ended_by_name text
);
create index if not exists service_data_access_requester on public.service_data_access (requester_id, service_id);
create index if not exists service_data_access_owner on public.service_data_access (owner_id, service_id);
-- One open request or permission per pair.
create unique index if not exists service_data_access_open on public.service_data_access (service_id, requester_id, owner_id)
  where status in ('pending', 'approved');

alter table public.service_data_access enable row level security;
revoke all on public.service_data_access from anon, authenticated;
grant select on public.service_data_access to authenticated;
drop policy if exists "Permisos de datos del servicio" on public.service_data_access;
create policy "Permisos de datos del servicio" on public.service_data_access for select to authenticated using (
  requester_id = (select auth.uid()) or owner_id = (select auth.uid())
);

/** Whether this person sees the whole service's data: the dirección (reports) or whoever sees every turn's detail. */
create or replace function private.sees_whole_service(me public.profiles)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.can(me, 'reports') or private.history_full(me)
$$;

/** Whose turns this person sees in a service's data: themselves and the colleagues who allowed them. */
create or replace function private.service_data_owners(p_service bigint, me public.profiles)
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select array[me.id] || coalesce(array(
    select a.owner_id from public.service_data_access a
    where a.service_id = p_service and a.requester_id = me.id and a.status = 'approved'), '{}')
$$;

-- Same as before, with who attended each turn; whoever attends the service gets only their own turns (and those of
-- whoever allowed them).
drop function if exists public.service_turns(bigint, timestamptz, timestamptz);
create or replace function public.service_turns(p_service_id bigint, p_from timestamptz, p_to timestamptz)
returns table (id bigint, service_id bigint, student_name text, student_key text, group_name text, severity smallint,
  status text, outcome text, reason text, created_by_name text, handled_by uuid, handled_by_name text, out_of_order boolean,
  created_at timestamptz, called_at timestamptz, sent_at timestamptz, arrived_at timestamptz, on_the_way_at timestamptz,
  returning_at timestamptz, closed_at timestamptz, late_at timestamptz, room text, resolution text)
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
      r.on_the_way_at, r.returning_at, r.closed_at, r.late_at, r.room, d.resolution
    from public.service_requests r
    left join public.service_request_details d on d.request_id = r.id
    where r.service_id = p_service_id and r.created_at >= p_from and r.created_at < p_to
      and (v_all or r.handled_by = any(v_owners))
    order by r.id;
end;
$$;
revoke execute on function public.service_turns(bigint, timestamptz, timestamptz) from public, anon;
grant execute on function public.service_turns(bigint, timestamptz, timestamptz) to authenticated;

/**
 * For the panel: whether this person sees the whole service, and their colleagues in it, with how things stand
 * between them (what I asked them, what they asked me).
 */
create or replace function public.service_data_people(p_service bigint)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  s public.school_services;
begin
  select * into s from public.school_services x where x.id = p_service and x.school_id = me.school_id;
  if s.id is null then raise exception 'No se encontró el servicio.'; end if;
  return jsonb_build_object(
    'all', private.sees_whole_service(me),
    'serves', private.roles_of(me) && s.roles,
    'colleagues', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', p.id, 'name', p.full_name,
          -- What I asked them (my access to their turns).
          'mine', (select jsonb_build_object('id', a.id, 'status', a.status, 'reason', a.reason, 'at', a.created_at)
                   from public.service_data_access a
                   where a.service_id = s.id and a.requester_id = me.id and a.owner_id = p.id and a.status in ('pending', 'approved')),
          -- What they asked me (their access to my turns).
          'theirs', (select jsonb_build_object('id', a.id, 'status', a.status, 'reason', a.reason, 'at', a.created_at)
                     from public.service_data_access a
                     where a.service_id = s.id and a.requester_id = p.id and a.owner_id = me.id and a.status in ('pending', 'approved')))
        order by p.full_name)
      from public.profiles p
      where p.school_id = s.school_id and p.active and p.id <> me.id and private.roles_of(p) && s.roles
    ), '[]'::jsonb));
end;
$$;
revoke execute on function public.service_data_people(bigint) from public, anon;
grant execute on function public.service_data_people(bigint) to authenticated;

/** Asks a colleague of the same service to see the turns they attended. */
create or replace function public.request_service_data(p_service bigint, p_owner uuid, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  s public.school_services;
  o public.profiles;
  v_reason text := private.clean_text(p_reason, 300, 'La razón');
begin
  select * into s from public.school_services x where x.id = p_service and x.school_id = me.school_id;
  if s.id is null then raise exception 'No se encontró el servicio.'; end if;
  if not (private.roles_of(me) && s.roles) then raise exception 'Solo quien atiende % puede pedirlo.', s.name; end if;
  select * into o from public.profiles p where p.id = p_owner and p.school_id = me.school_id and p.active;
  if o.id is null or o.id = me.id or not (private.roles_of(o) && s.roles) then
    raise exception 'Esa persona no atiende %.', s.name;
  end if;
  if v_reason is null then raise exception 'Escribe para qué lo necesitas.'; end if;
  if exists (select 1 from public.service_data_access a where a.service_id = s.id and a.requester_id = me.id
             and a.owner_id = o.id and a.status in ('pending', 'approved')) then
    raise exception 'Ya se lo pediste a %.', o.full_name;
  end if;
  insert into public.service_data_access (school_id, service_id, requester_id, requester_name, owner_id, owner_name, reason)
  values (me.school_id, s.id, me.id, me.full_name, o.id, o.full_name, v_reason);
  perform private.notify(array[o.id], format('🔒 %s pide ver tus datos de %s', me.full_name, s.name),
    format('Para qué: «%s». Tócalo para permitirlo o no.', left(v_reason, 140)), '#/turns/panel/' || s.id);
  perform private.log_activity(me.school_id, me.id, format('Pidió ver los datos de %s en %s', o.full_name, s.name),
    v_reason, '#/turns/panel/' || s.id, o.id);
end;
$$;
revoke execute on function public.request_service_data(bigint, uuid, text) from public, anon;
grant execute on function public.request_service_data(bigint, uuid, text) to authenticated;

/** The colleague answers: allow (true) or not (false). */
create or replace function public.answer_service_data(p_id bigint, p_allow boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  a public.service_data_access;
  v_service text;
begin
  select * into a from public.service_data_access x where x.id = p_id and x.owner_id = me.id for update;
  if a.id is null then raise exception 'No se encontró esa solicitud.'; end if;
  if a.status <> 'pending' then raise exception 'Esa solicitud ya se contestó.'; end if;
  select name into v_service from public.school_services where id = a.service_id;
  update public.service_data_access set status = case when p_allow then 'approved' else 'denied' end, decided_at = now()
  where id = a.id;
  perform private.notify(array[a.requester_id],
    case when p_allow then format('✅ %s te permitió ver sus datos de %s', me.full_name, v_service)
      else format('%s no permitió ver sus datos de %s', me.full_name, v_service) end,
    case when p_allow then 'Ya salen en tu panel.' else 'Si lo necesitas, habla con tu supervisor.' end,
    '#/turns/panel/' || a.service_id);
  perform private.log_activity(me.school_id, me.id,
    format('%s que %s viera sus datos de %s', case when p_allow then 'Permitió' else 'No permitió' end, a.requester_name, v_service),
    null, '#/turns/panel/' || a.service_id, a.requester_id);
end;
$$;
revoke execute on function public.answer_service_data(bigint, boolean) from public, anon;
grant execute on function public.answer_service_data(bigint, boolean) to authenticated;

/** Ends a permission or a pending request (whoever gave it or whoever asked). */
create or replace function public.end_service_data(p_id bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  a public.service_data_access;
  v_service text;
  v_other uuid;
begin
  select * into a from public.service_data_access x
  where x.id = p_id and (x.owner_id = me.id or x.requester_id = me.id) for update;
  if a.id is null then raise exception 'No se encontró ese permiso.'; end if;
  if a.status not in ('pending', 'approved') then raise exception 'Ese permiso ya terminó.'; end if;
  select name into v_service from public.school_services where id = a.service_id;
  update public.service_data_access set status = 'ended', ended_at = now(), ended_by_name = me.full_name where id = a.id;
  v_other := case when me.id = a.owner_id then a.requester_id else a.owner_id end;
  if a.status = 'approved' and me.id = a.owner_id then
    perform private.notify(array[v_other], format('%s quitó el permiso de ver sus datos de %s', me.full_name, v_service),
      'Ya no salen en tu panel.', '#/turns/panel/' || a.service_id);
  end if;
  perform private.log_activity(me.school_id, me.id,
    case when a.status = 'pending' then format('Retiró la solicitud de ver los datos de %s en %s', a.owner_name, v_service)
      when me.id = a.owner_id then format('Quitó el permiso de %s para ver sus datos de %s', a.requester_name, v_service)
      else format('Dejó de ver los datos de %s en %s', a.owner_name, v_service) end,
    null, '#/turns/panel/' || a.service_id, v_other);
end;
$$;
revoke execute on function public.end_service_data(bigint) from public, anon;
grant execute on function public.end_service_data(bigint) to authenticated;

-- ---- «Tu día en Enfermería»: when the service's hours end -------------------------------------------------------

create table if not exists public.service_day_summaries (
  service_id bigint not null references public.school_services (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  day date not null,
  sent_at timestamptz not null default now(),
  primary key (service_id, user_id, day)
);
alter table public.service_day_summaries enable row level security;
revoke all on public.service_day_summaries from anon, authenticated;

/**
 * Every few minutes: for each active service whose hours ended (up to 3 hours before), on a school day, each person
 * who attended turns today gets their own day once: «Atendiste a 12 · 3 referidos · 1 lo recogieron».
 */
create or replace function private.send_service_summaries()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  s record;
  p record;
  v_local timestamp;
  v_day date;
  v_from timestamptz;
  v_body text;
begin
  for s in
    select x.*, coalesce(st.time_zone, 'America/Puerto_Rico') as tz,
      coalesce(st.school_days, '{1,2,3,4,5}'::smallint[]) as school_days, h.closes
    from public.school_services x
    join public.schools sc on sc.id = x.school_id and sc.active
    left join public.school_settings st on st.school_id = x.school_id
    cross join lateral private.service_hours(x) h
    where x.active
  loop
    v_local := now() at time zone s.tz;
    v_day := v_local::date;
    continue when not extract(isodow from v_day)::smallint = any(s.school_days)
      or v_local < v_day + s.closes or v_local >= v_day + s.closes + interval '3 hours'
      or exists (select 1 from public.school_closures c where c.school_id = s.school_id and v_day between c.start_date and c.end_date);
    v_from := v_day::timestamp at time zone s.tz;
    for p in
      select r.handled_by as id, count(*) as turns,
        count(*) filter (where r.outcome = 'referred') as referred,
        count(*) filter (where r.outcome = 'picked_up') as picked_up,
        count(*) filter (where r.outcome in ('attended', 'returned', 'unconfirmed')) as attended,
        count(distinct r.student_key) as students
      from public.service_requests r
      join public.profiles pr on pr.id = r.handled_by and pr.active
      where r.service_id = s.id and r.created_at >= v_from and r.created_at < v_from + interval '1 day'
        and r.status <> 'cancelled'
      group by r.handled_by
    loop
      insert into public.service_day_summaries (service_id, user_id, day) values (s.id, p.id, v_day) on conflict do nothing;
      continue when not found;
      v_body := concat_ws(' · ',
        case when s.mode = 'support' then format('%s %s', p.turns, case when p.turns = 1 then 'pedido' else 'pedidos' end)
          else format('Atendiste a %s %s', p.students, case when p.students = 1 then 'estudiante' else 'estudiantes' end) end,
        case when p.referred > 0 then format('%s %s', p.referred, case when s.mode = 'support' then 'con seguimiento'
          when p.referred = 1 then 'referido' else 'referidos' end) end,
        case when p.picked_up > 0 then format('%s %s', p.picked_up, case when p.picked_up = 1 then 'lo recogieron' else 'los recogieron' end) end)
        || '. Toca para ver tus datos del día.';
      perform private.notify_tagged(array[p.id], format('📊 Tu día en %s', s.name), v_body,
        '#/turns/panel/' || s.id || '?day=' || to_char(v_day, 'YYYY-MM-DD'), 'service-day-' || s.id || '-' || v_day, false);
    end loop;
  end loop;
end;
$$;
revoke execute on function private.send_service_summaries() from public, anon, authenticated;

select cron.schedule('hallway-service-summary', '*/5 * * * *', 'select private.send_service_summaries()');
