-- Medicamentos diarios: the students Enfermería gives medication to every day, at set times.
--   · The list (medication_plans): the student (name and group: the students' table only keeps names 24 hours), the
--     medication and dose, the times, the days of the week, from when and until when, and whether the app calls the
--     student by itself at that time («Llamarlo automáticamente») or the nurse does.
--   · Each dose (medication_doses): one row per student, day and time, kept as the record: «Se medicó», «Ausente»,
--     «No se medicó» (with why) or nothing marked; who called them and who marked it.
--   · Calling: the same as calling a turn. A turn «Medicamento» already called; the group's teachers hear «💊 Envía a …
--     a Enfermería» (it doesn't say which medication) and tap «Ya salió» as with any turn.
--   · Only whoever attends the service and the dirección (Admin, «Ver el detalle de los turnos», «Datos y reportes»)
--     see the list and the record. Kept a little over a year.

alter table public.school_services add column if not exists medication boolean not null default false;
update public.school_services set medication = true where name ilike 'enfermer%' and not medication;

/** A new Enfermería comes with the record of medication on. */
create or replace function private.service_default_medication()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.name ilike 'enfermer%' then new.medication := true; end if;
  return new;
end;
$$;
drop trigger if exists school_services_default_medication on public.school_services;
create trigger school_services_default_medication before insert on public.school_services
for each row execute function private.service_default_medication();

create table if not exists public.medication_plans (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools (id) on delete cascade,
  service_id bigint not null references public.school_services (id) on delete cascade,
  student_name text not null check (char_length(student_name) between 2 and 100),
  student_key text not null,
  group_name text not null,
  medication text not null check (char_length(medication) between 2 and 120),
  times time[] not null check (cardinality(times) between 1 and 6),
  weekdays smallint[] not null default '{1,2,3,4,5}',
  auto_call boolean not null default true,
  start_date date not null,
  end_date date,
  note text check (char_length(note) <= 300),
  active boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_by_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz,
  ended_by_name text
);
create index if not exists medication_plans_service on public.medication_plans (service_id, active);

create table if not exists public.medication_doses (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools (id) on delete cascade,
  service_id bigint not null references public.school_services (id) on delete cascade,
  plan_id bigint references public.medication_plans (id) on delete set null,
  day date not null,
  at_time time not null,
  student_name text not null,
  student_key text not null,
  group_name text not null,
  medication text not null,
  status text not null default 'pending' check (status in ('pending', 'called', 'given', 'absent', 'not_given')),
  reason text check (char_length(reason) <= 300),
  request_id bigint references public.service_requests (id) on delete set null,
  called_at timestamptz,
  called_by_name text,
  done_at timestamptz,
  done_by uuid references public.profiles (id) on delete set null,
  done_by_name text,
  created_at timestamptz not null default now(),
  unique (plan_id, day, at_time)
);
create index if not exists medication_doses_service on public.medication_doses (service_id, day);
create index if not exists medication_doses_day on public.medication_doses (day);

/** Whether this person sees a service's medication: who attends it and the dirección. */
create or replace function private.medication_ok(p_service bigint)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p join public.school_services s on s.id = p_service and s.school_id = p.school_id
    where p.id = (select auth.uid()) and p.active and (private.roles_of(p) && s.roles or private.sees_whole_service(p)))
$$;

alter table public.medication_plans enable row level security;
alter table public.medication_doses enable row level security;
revoke all on public.medication_plans, public.medication_doses from anon, authenticated;
grant select on public.medication_plans, public.medication_doses to authenticated;
drop policy if exists "Medicamentos del servicio" on public.medication_plans;
create policy "Medicamentos del servicio" on public.medication_plans for select to authenticated
  using (private.medication_ok(service_id));
drop policy if exists "Registro de medicamentos" on public.medication_doses;
create policy "Registro de medicamentos" on public.medication_doses for select to authenticated
  using (private.medication_ok(service_id));

/** The school's local time (its time zone). */
create or replace function private.school_now(p_school uuid)
returns timestamp
language sql stable security definer set search_path = ''
as $$
  select now() at time zone coalesce((select st.time_zone from public.school_settings st where st.school_id = p_school), 'America/Puerto_Rico')
$$;

/** A school day: one of the school's weekdays and not a day off. */
create or replace function private.is_school_day(p_school uuid, p_day date)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select extract(isodow from p_day)::smallint = any(coalesce(
      (select s.school_days from public.school_settings s where s.school_id = p_school), '{1,2,3,4,5}'::smallint[]))
    and not exists (select 1 from public.school_closures c where c.school_id = p_school and p_day between c.start_date and c.end_date)
$$;

/** Whether a student of the list takes medication on that day. */
create or replace function private.plan_on(p public.medication_plans, p_day date)
returns boolean
language sql stable set search_path = ''
as $$
  select p.start_date <= p_day and (p.end_date is null or p.end_date >= p_day)
    and extract(isodow from p_day)::smallint = any(p.weekdays)
    and (p.active or p.ended_at::date > p_day)
$$;

/** The dose of a student, day and time; made (pending) if it isn't there yet. */
create or replace function private.dose_of(p public.medication_plans, p_day date, p_time time)
returns public.medication_doses
language plpgsql security definer set search_path = ''
as $$
declare
  d public.medication_doses;
begin
  insert into public.medication_doses (school_id, service_id, plan_id, day, at_time, student_name, student_key, group_name, medication)
  values (p.school_id, p.service_id, p.id, p_day, p_time, p.student_name, p.student_key, p.group_name, p.medication)
  on conflict (plan_id, day, at_time) do nothing;
  select * into d from public.medication_doses x where x.plan_id = p.id and x.day = p_day and x.at_time = p_time;
  return d;
end;
$$;

/**
 * Calls the student for that dose, as a turn already called («Medicamento»): the group's teachers hear it and tap
 * «Ya salió». p_actor null: the app, at the time set. If the student already has a turn open in the service, that one.
 */
create or replace function private.call_dose(p public.medication_plans, p_day date, p_time time, p_actor public.profiles)
returns public.medication_doses
language plpgsql security definer set search_path = ''
as $$
declare
  s public.school_services;
  d public.medication_doses := private.dose_of(p, p_day, p_time);
  r public.service_requests;
  v_by text;
begin
  if d.status in ('given', 'absent', 'not_given') then raise exception 'Esa dosis ya está marcada.'; end if;
  if d.request_id is not null and exists (
    select 1 from public.service_requests x where x.id = d.request_id and x.status not in ('done', 'cancelled')
  ) then
    return d;
  end if;
  select * into s from public.school_services x where x.id = p.service_id;
  v_by := coalesce(p_actor.full_name, s.name);
  select * into r from public.service_requests x
  where x.service_id = s.id and x.student_key = p.student_key and x.group_name = p.group_name
    and x.status not in ('done', 'cancelled')
  order by x.id desc limit 1;
  if r.id is null then
    insert into public.service_requests (
      school_id, service_id, student_name, student_key, group_name, severity, status,
      created_by, created_by_name, handled_by, handled_by_name, called_at, remind_at, reminders, flow
    ) values (
      p.school_id, s.id, p.student_name, p.student_key, p.group_name, 2, 'called',
      p_actor.id, v_by, p_actor.id, v_by, now(), now() + interval '3 minutes', 0,
      case when s.mode = 'either' then 'visit' end
    )
    returning * into r;
    insert into public.service_request_details (request_id, school_id, service_id, created_by, reason, note)
    values (r.id, r.school_id, s.id, p_actor.id, 'Medicamento', null);
    perform private.notify_tagged(
      private.group_teacher_ids(p.school_id, p.group_name, array_remove(array[p_actor.id], null)),
      format('💊 Envía a %s (%s) a %s', p.student_name, p.group_name, s.name),
      'Le toca su medicamento. Si está contigo, envíalo y toca «Ya salió».',
      '#/turns/' || r.id, 'turn-' || r.id, false);
  end if;
  update public.medication_doses
  set status = 'called', called_at = now(), called_by_name = coalesce(p_actor.full_name, 'Sistema'), request_id = r.id
  where id = d.id
  returning * into d;
  return d;
end;
$$;

/** «Añadir estudiante» / «Guardar»: a student of the list, new (p_id null) or changed. */
create or replace function public.save_medication_plan(
  p_id bigint, p_service bigint, p_name text, p_group text, p_medication text, p_times text[], p_weekdays int[],
  p_auto boolean, p_start date, p_end date, p_note text
)
returns public.medication_plans
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  s public.school_services;
  p public.medication_plans;
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_group text;
  v_med text := private.clean_text(p_medication, 120, 'El medicamento');
  v_note text := private.clean_text(p_note, 300, 'La nota');
  v_times time[];
  v_days smallint[];
  v_start date := coalesce(p_start, private.school_now(me.school_id)::date);
begin
  select * into s from public.school_services x where x.id = p_service and x.school_id = me.school_id;
  if s.id is null or not s.medication then raise exception 'Este servicio no lleva registro de medicamentos.'; end if;
  if not private.medication_ok(s.id) then raise exception 'Solo % y la dirección manejan los medicamentos.', s.name; end if;
  if char_length(v_name) < 2 then raise exception 'Escribe el nombre del estudiante.'; end if;
  if char_length(v_name) > 100 then raise exception 'El nombre es demasiado largo (máx. 100 caracteres).'; end if;
  v_group := private.school_group(me.school_id, p_group);
  if v_med is null or char_length(v_med) < 2 then raise exception 'Escribe el medicamento y la dosis.'; end if;
  begin
    select array_agg(distinct t::time order by t::time) into v_times
    from unnest(coalesce(p_times, '{}'::text[])) t where btrim(t) <> '';
  exception when others then
    raise exception 'Revisa las horas.';
  end;
  if coalesce(cardinality(v_times), 0) = 0 then raise exception 'Escribe a qué hora se medica.'; end if;
  if cardinality(v_times) > 6 then raise exception 'Hasta 6 horas al día.'; end if;
  select array_agg(distinct d::smallint order by d::smallint) into v_days
  from unnest(coalesce(p_weekdays, '{}'::int[])) d where d between 1 and 7;
  if coalesce(cardinality(v_days), 0) = 0 then raise exception 'Elige qué días se medica.'; end if;
  if p_end is not null and p_end < v_start then raise exception 'La fecha final debe ser después de la inicial.'; end if;

  if p_id is null then
    if (select count(*) from public.medication_plans x where x.service_id = s.id and x.active) >= 300 then
      raise exception 'La lista llegó al máximo (300 estudiantes).';
    end if;
    insert into public.medication_plans (school_id, service_id, student_name, student_key, group_name, medication, times,
      weekdays, auto_call, start_date, end_date, note, created_by, created_by_name)
    values (me.school_id, s.id, v_name, private.student_key(v_name), v_group, v_med, v_times, v_days,
      coalesce(p_auto, true), v_start, p_end, v_note, me.id, me.full_name)
    returning * into p;
    perform private.log_activity(me.school_id, me.id,
      format('Añadió a %s (%s) a los medicamentos de %s', v_name, v_group, s.name), null, '#/medication/' || s.id, null);
  else
    update public.medication_plans x
    set student_name = v_name, student_key = private.student_key(v_name), group_name = v_group, medication = v_med,
      times = v_times, weekdays = v_days, auto_call = coalesce(p_auto, x.auto_call), start_date = v_start, end_date = p_end,
      note = v_note, updated_at = now()
    where x.id = p_id and x.service_id = s.id and x.active
    returning * into p;
    if p.id is null then raise exception 'No se encontró ese estudiante en la lista.'; end if;
    perform private.log_activity(me.school_id, me.id,
      format('Cambió los medicamentos de %s (%s) en %s', v_name, v_group, s.name), null, '#/medication/' || s.id, null);
  end if;
  return p;
end;
$$;

/** «Quitar de la lista»: no more doses from today on; its record stays. */
create or replace function public.end_medication_plan(p_id bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  p public.medication_plans;
begin
  select * into p from public.medication_plans x where x.id = p_id and x.school_id = me.school_id and x.active;
  if p.id is null or not private.medication_ok(p.service_id) then raise exception 'No se encontró ese estudiante en la lista.'; end if;
  update public.medication_plans set active = false, ended_at = now(), ended_by_name = me.full_name, updated_at = now()
  where id = p.id;
  perform private.log_activity(me.school_id, me.id,
    format('Quitó a %s (%s) de los medicamentos', p.student_name, p.group_name), null, '#/medication/' || p.service_id, null);
end;
$$;

/** The day's doses of a service: each student of the list who takes medication that day, at each time, and what was done. */
create or replace function public.medication_day(p_service bigint, p_day date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_day date := coalesce(p_day, private.school_now(me.school_id)::date);
begin
  if not private.medication_ok(p_service) then raise exception 'Solo quien atiende el servicio y la dirección ven los medicamentos.'; end if;
  return jsonb_build_object(
    'day', v_day,
    'school_day', private.is_school_day(me.school_id, v_day),
    'now', to_char(private.school_now(me.school_id), 'HH24:MI'),
    'doses', coalesce((
      select jsonb_agg(x order by x->>'at_time', x->>'student_name')
      from (
        select jsonb_build_object(
          'plan_id', p.id, 'student_name', p.student_name, 'group_name', p.group_name, 'medication', coalesce(d.medication, p.medication),
          'note', p.note, 'auto_call', p.auto_call, 'at_time', to_char(t, 'HH24:MI'),
          'dose_id', d.id, 'status', coalesce(d.status, 'pending'), 'reason', d.reason,
          'called_at', d.called_at, 'called_by_name', d.called_by_name, 'done_at', d.done_at, 'done_by_name', d.done_by_name,
          'request_id', d.request_id, 'request_status', r.status) as x
        from public.medication_plans p
        cross join lateral unnest(p.times) t
        left join public.medication_doses d on d.plan_id = p.id and d.day = v_day and d.at_time = t
        left join public.service_requests r on r.id = d.request_id
        where p.service_id = p_service and (private.plan_on(p, v_day) or d.id is not null)
        union all
        -- Doses of that day whose time or student is no longer on the list.
        select jsonb_build_object(
          'plan_id', d.plan_id, 'student_name', d.student_name, 'group_name', d.group_name, 'medication', d.medication,
          'note', null, 'auto_call', false, 'at_time', to_char(d.at_time, 'HH24:MI'),
          'dose_id', d.id, 'status', d.status, 'reason', d.reason,
          'called_at', d.called_at, 'called_by_name', d.called_by_name, 'done_at', d.done_at, 'done_by_name', d.done_by_name,
          'request_id', d.request_id, 'request_status', r.status)
        from public.medication_doses d
        left join public.service_requests r on r.id = d.request_id
        where d.service_id = p_service and d.day = v_day
          and not exists (select 1 from public.medication_plans p where p.id = d.plan_id and d.at_time = any(p.times))
      ) y(x)
    ), '[]'::jsonb));
end;
$$;

/** «Llamar»: the nurse calls the student for that dose now (today). */
create or replace function public.call_medication(p_plan bigint, p_time text)
returns public.medication_doses
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  p public.medication_plans;
  v_day date := private.school_now(me.school_id)::date;
begin
  select * into p from public.medication_plans x where x.id = p_plan and x.school_id = me.school_id;
  if p.id is null or not private.medication_ok(p.service_id) then raise exception 'No se encontró ese estudiante en la lista.'; end if;
  if not (p_time::time = any(p.times)) or not private.plan_on(p, v_day) then raise exception 'Hoy no le toca a esa hora.'; end if;
  return private.call_dose(p, v_day, p_time::time, me);
end;
$$;

/**
 * «Se medicó», «Ausente» or «No se medicó» (with why): the dose of that day and time. If it was called and the turn is
 * still open, the turn ends too: «Se medicó», back to class; otherwise, cancelled with the reason.
 */
create or replace function public.mark_medication(p_plan bigint, p_day date, p_time text, p_status text, p_reason text)
returns public.medication_doses
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  p public.medication_plans;
  d public.medication_doses;
  r public.service_requests;
  v_reason text := private.clean_text(p_reason, 300, 'La razón');
  v_today date := private.school_now(me.school_id)::date;
begin
  if p_status is null or p_status not in ('given', 'absent', 'not_given', 'pending') then raise exception 'Elige qué pasó.'; end if;
  if p_status = 'not_given' and v_reason is null then raise exception 'Escribe por qué no se medicó.'; end if;
  select * into p from public.medication_plans x where x.id = p_plan and x.school_id = me.school_id;
  if p.id is null or not private.medication_ok(p.service_id) then raise exception 'No se encontró ese estudiante en la lista.'; end if;
  if p_day is null or p_day > v_today or p_day < v_today - 30 then raise exception 'Solo se marcan los últimos 30 días.'; end if;
  if not exists (select 1 from public.medication_doses x where x.plan_id = p.id and x.day = p_day and x.at_time = p_time::time)
     and not (p_time::time = any(p.times) and private.plan_on(p, p_day)) then
    raise exception 'Ese día no le tocaba a esa hora.';
  end if;
  d := private.dose_of(p, p_day, p_time::time);
  update public.medication_doses
  set status = case when p_status = 'pending' then case when request_id is not null then 'called' else 'pending' end else p_status end,
    reason = case when p_status in ('absent', 'not_given') then v_reason end,
    done_at = case when p_status = 'pending' then null else now() end,
    done_by = case when p_status = 'pending' then null else me.id end,
    done_by_name = case when p_status = 'pending' then null else me.full_name end
  where id = d.id
  returning * into d;

  select * into r from public.service_requests x where x.id = d.request_id and x.status not in ('done', 'cancelled');
  if r.id is not null and p_status = 'given' then
    update public.service_requests
    set status = 'done', outcome = 'returned', closed_at = now(), closed_by_name = me.full_name
    where id = r.id;
    perform private.close_notifications('#/turns/' || r.id);
  elsif r.id is not null and p_status in ('absent', 'not_given') then
    update public.service_requests
    set status = 'cancelled', outcome = 'cancelled', closed_at = now(), closed_by_name = me.full_name
    where id = r.id;
    insert into public.service_request_messages
      (request_id, school_id, service_id, requester_id, student_name, turn_day, author_id, author_name, author_side, kind, body)
    values (r.id, r.school_id, r.service_id, r.created_by, r.student_name, p_day, me.id, me.full_name, 'service', 'cancel',
      case when p_status = 'absent' then coalesce('Ausente: ' || v_reason, 'Ausente') else 'No se medicó: ' || v_reason end);
    perform private.close_notifications('#/turns/' || r.id);
  end if;
  return d;
end;
$$;

/** The list: who takes medication (the current ones first, then those taken off). */
create or replace function public.medication_plans(p_service bigint)
returns setof public.medication_plans
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.medication_ok(p_service) then raise exception 'Solo quien atiende el servicio y la dirección ven los medicamentos.'; end if;
  return query select * from public.medication_plans x where x.service_id = p_service
    and (x.active or x.ended_at > now() - interval '400 days')
    order by x.active desc, x.student_name;
end;
$$;

/** The record of a period: every dose of every school day, also those nobody marked. */
create or replace function public.medication_log(p_service bigint, p_from date, p_to date)
returns setof public.medication_doses
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.medication_ok(p_service) then raise exception 'Solo quien atiende el servicio y la dirección ven los medicamentos.'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'Elige un período de hasta un año.'; end if;
  return query select * from public.medication_doses d where d.service_id = p_service and d.day between p_from and p_to
    order by d.day, d.at_time, d.student_name;
end;
$$;

/** «Configurar Turnos»: whether a service keeps the record of medication. */
create or replace function public.set_service_medication(p_id bigint, p_on boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
begin
  if not private.can(me, 'services') then raise exception 'No tienes permiso para cambiar los servicios.'; end if;
  update public.school_services set medication = coalesce(p_on, false) where id = p_id and school_id = me.school_id;
  if not found then raise exception 'No se encontró el servicio.'; end if;
end;
$$;

/**
 * Every minute: at each dose's time on a school day, the app calls the student (when «Llamarlo automáticamente») or
 * reminds the service to do it. Doses due up to 20 minutes ago still go; later ones wait for the nurse.
 */
create or replace function private.medication_tick()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  x record;
  d public.medication_doses;
begin
  for x in
    select p as plan, t, n.local::date as day
    from public.medication_plans p
    join public.school_services s on s.id = p.service_id and s.active and s.medication
    join public.schools sc on sc.id = p.school_id and sc.active
    cross join lateral (select private.school_now(p.school_id) as local) n
    cross join lateral unnest(p.times) t
    where p.active and private.plan_on(p, n.local::date)
      and t <= n.local::time and t > n.local::time - interval '20 minutes'
      and private.is_school_day(p.school_id, n.local::date)
      and not exists (select 1 from public.medication_doses m where m.plan_id = p.id and m.day = n.local::date and m.at_time = t)
  loop
    if (x.plan).auto_call then
      begin
        perform private.call_dose(x.plan, x.day, x.t, null);
        continue;
      exception when others then
        null; -- it couldn't be called (e.g. the service is closed): the service is reminded below
      end;
    end if;
    d := private.dose_of(x.plan, x.day, x.t);
    perform private.notify_tagged(private.service_staff_ids((x.plan).service_id, null),
      format('💊 Medicamento de las %s', to_char(x.t, 'FMHH12:MI') || case when x.t < '12:00' then ' a. m.' else ' p. m.' end),
      format('%s (%s). Toca para llamarlo o marcarlo.', (x.plan).student_name, (x.plan).group_name),
      '#/medication/' || (x.plan).service_id, 'med-' || (x.plan).id || '-' || x.day || '-' || to_char(x.t, 'HH24MI'), false);
  end loop;
  -- The record is kept a little over a year.
  delete from public.medication_doses where day < current_date - 400;
end;
$$;

revoke execute on function private.medication_tick(), private.call_dose(public.medication_plans, date, time, public.profiles),
  private.dose_of(public.medication_plans, date, time) from public, anon, authenticated;
revoke execute on function public.save_medication_plan(bigint, bigint, text, text, text, text[], int[], boolean, date, date, text),
  public.end_medication_plan(bigint), public.medication_day(bigint, date), public.call_medication(bigint, text),
  public.mark_medication(bigint, date, text, text, text), public.medication_plans(bigint), public.medication_log(bigint, date, date),
  public.set_service_medication(bigint, boolean) from public, anon;
grant execute on function public.save_medication_plan(bigint, bigint, text, text, text, text[], int[], boolean, date, date, text),
  public.end_medication_plan(bigint), public.medication_day(bigint, date), public.call_medication(bigint, text),
  public.mark_medication(bigint, date, text, text, text), public.medication_plans(bigint), public.medication_log(bigint, date, date),
  public.set_service_medication(bigint, boolean) to authenticated;

select cron.schedule('hallway-medication', '* * * * *', 'select private.medication_tick()');

-- Same as in 20261227000091, with whether the service keeps the record of medication.
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
        'open_from', to_char(s.open_from, 'HH24:MI'), 'open_until', to_char(s.open_until, 'HH24:MI'),
        'opens', (select to_char(h.opens, 'HH24:MI') from private.service_hours(s) h),
        'closes', (select to_char(h.closes, 'HH24:MI') from private.service_hours(s) h),
        'closed_reason', private.service_closed(s),
        'serves', private.roles_of(me) && s.roles,
        'form_fields', s.form_fields,
        'medication', s.medication,
        'waiting', (select count(*) from public.service_requests x where x.service_id = s.id and x.status = 'waiting'),
        'staff', (
          select coalesce(jsonb_agg(jsonb_build_object(
              'id', p.id, 'name', p.full_name, 'status', private.staff_status(st),
              'until', case when private.staff_status(st) <> 'available' then st.until end,
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
