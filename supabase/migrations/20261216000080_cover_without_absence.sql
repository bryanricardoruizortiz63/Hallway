-- Covering a class without an absence. When a teacher is out doing school work (an extracurricular activity, a trip,
-- a meeting) the students still need someone in the classroom, but the teacher isn't absent. The dirección (who can
-- register the staff's absences) notes it as «Actividad de la escuela», with where the teacher will be, and then
-- chooses who covers, exactly as with an absence.
--
-- It is kept as a row of absences with category 'actividad', so everything about covering works the same (who covers,
-- their notice, «Vas a cubrir», the material, Teams). But it isn't an absence:
--   * only the dirección notes it or changes it (the teacher can see it, not cancel it);
--   * nothing to confirm: it is noted as received;
--   * it doesn't count as an absence (the person's count, the daily summary), and the teacher keeps getting their
--     notices while away.

alter table public.absences drop constraint if exists absences_category_check;
alter table public.absences add constraint absences_category_check
  check (category in ('enfermedad', 'cita_medica', 'personal', 'familiar', 'oficial', 'otro', 'actividad'));

create or replace function private.category_label(c text)
returns text
language sql immutable set search_path = ''
as $$
  select case c
    when 'enfermedad' then 'Enfermedad'
    when 'cita_medica' then 'Cita médica'
    when 'personal' then 'Asunto personal'
    when 'familiar' then 'Emergencia familiar'
    when 'oficial' then 'Capacitación / oficial'
    when 'otro' then 'Otro'
    when 'actividad' then 'Actividad de la escuela'
  end
$$;

/**
 * Guards the classes to cover without an absence: only the dirección notes or changes one, an absence can't become one
 * (or the other way round), and it never waits for confirmation.
 */
create or replace function private.duty_guard()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles;
begin
  if tg_op = 'UPDATE' and old.category = 'actividad' and new.category is distinct from 'actividad' then
    raise exception 'Este registro es una actividad de la escuela, no una ausencia: no se le puede cambiar el tipo.';
  end if;
  if tg_op = 'UPDATE' and old.category is distinct from 'actividad' and new.category = 'actividad' then
    raise exception 'Tipo de ausencia no válido.';
  end if;
  if new.category is distinct from 'actividad' then return new; end if;

  if auth.uid() is not null then
    select * into me from public.profiles where id = auth.uid();
    -- What and when it is (not who covers: whoever covers answers on it too).
    if tg_op = 'INSERT' or (new.user_id, new.start_date, new.end_date, new.partial, new.start_time, new.end_time, new.reason, new.status)
        is distinct from (old.user_id, old.start_date, old.end_date, old.partial, old.start_time, old.end_time, old.reason, old.status) then
      if me.id is null or not private.can(me, 'register') then
        raise exception 'Solo la dirección puede anotar o cambiar una clase por cubrir sin ausencia.';
      end if;
    end if;
    if tg_op = 'INSERT' and new.user_id = me.id then
      raise exception 'Elige el maestro cuya clase hay que cubrir.';
    end if;
  end if;
  if coalesce(btrim(new.reason), '') = '' then
    raise exception 'Escribe dónde estará el maestro (por ejemplo, la actividad).';
  end if;
  -- It isn't an absence: there is nothing to confirm.
  if new.status = 'pending' then
    new.status := 'received';
    new.received_by := coalesce(new.received_by, me.id);
    new.received_by_name := coalesce(new.received_by_name, me.full_name, 'la dirección');
    new.received_at := coalesce(new.received_at, now());
  end if;
  return new;
end;
$$;
drop trigger if exists absences_duty_guard on public.absences;
create trigger absences_duty_guard before insert or update on public.absences
  for each row execute function private.duty_guard();

-- Same as in 20261115000049, with its own notices for a class to cover without an absence.
create or replace function public.create_absence(
  p_start_date date,
  p_end_date date default null,
  p_partial boolean default false,
  p_start_time time default null,
  p_end_time time default null,
  p_category text default null,
  p_reason text default null,
  p_coverage_notes text default null,
  p_user_id uuid default null,
  p_today date default null,
  p_files jsonb default '[]'::jsonb
)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  emp public.profiles;
  v_today date := case when p_today between current_date - 1 and current_date + 1 then p_today else current_date end;
  v_partial boolean := coalesce(p_partial, false);
  v_end date;
  v_start_time time;
  v_end_time time;
  v_category text := nullif(btrim(p_category), '');
  v_duty boolean := nullif(btrim(p_category), '') = 'actividad';
  v_id bigint;
  v_files int;
  v_summary text;
  v_reason text;
begin
  if v_duty and not private.can(me, 'register') then
    raise exception 'Solo la dirección puede anotar una clase por cubrir sin ausencia.';
  end if;
  if p_user_id is not null and p_user_id <> me.id then
    if not private.can(me, 'register') then
      raise exception 'No tienes permiso para registrar ausencias de otros empleados.';
    end if;
    select * into emp from public.profiles
    where id = p_user_id and school_id = me.school_id and active and role <> 'admin';
    if emp.id is null then
      raise exception 'El empleado seleccionado no existe o está inactivo.';
    end if;
  else
    if v_duty then
      raise exception 'Elige el maestro cuya clase hay que cubrir.';
    end if;
    if me.role = 'admin' then
      raise exception 'Selecciona el empleado que va a faltar.';
    end if;
    if not coalesce((select r.own_absences from public.school_roles r where r.school_id = me.school_id and r.key = me.role), true) then
      raise exception 'Tu rol no reporta sus propias ausencias en Hallway. Si hace falta, pídeselo a la dirección.';
    end if;
    emp := me;
  end if;

  if p_start_date is null then
    raise exception 'Selecciona una fecha válida.';
  end if;
  v_end := case when v_partial then p_start_date else coalesce(p_end_date, p_start_date) end;
  if v_end < p_start_date then
    raise exception 'La fecha final no puede ser antes de la fecha inicial.';
  end if;
  if v_end - p_start_date > 90 then
    raise exception 'Una ausencia no puede durar más de 90 días.';
  end if;
  if v_today - p_start_date > 60 then
    raise exception 'La fecha es demasiado antigua (máx. 60 días atrás).';
  end if;
  if p_start_date - v_today > 365 then
    raise exception 'La fecha es demasiado lejana.';
  end if;

  if v_partial then
    if p_start_time is null then
      raise exception 'Indica la hora de inicio de la ausencia.';
    end if;
    if p_end_time is null then
      raise exception 'Indica la hora final de la ausencia.';
    end if;
    if p_end_time <= p_start_time then
      raise exception 'La hora final debe ser después de la hora de inicio.';
    end if;
    v_start_time := p_start_time;
    v_end_time := p_end_time;
  end if;

  if v_category is not null and private.category_label(v_category) is null then
    raise exception 'Tipo de ausencia no válido.';
  end if;
  v_reason := private.clean_text(p_reason, 1000, 'La causa');

  insert into public.absences (
    school_id, user_id, created_by, created_by_name, start_date, end_date, partial, start_time, end_time,
    category, reason, coverage_notes
  )
  values (
    me.school_id, emp.id, me.id, me.full_name, p_start_date, v_end, v_partial, v_start_time, v_end_time,
    v_category, v_reason, private.clean_text(p_coverage_notes, 1000, 'Las notas para cubrir')
  )
  returning id into v_id;

  v_files := private.insert_attachments(v_id, me, p_files);

  if v_duty then
    v_summary := private.fmt_range(p_start_date, v_end) || ' · ' || private.fmt_schedule(v_partial, v_start_time, v_end_time)
      || ' · Actividad de la escuela: ' || left(v_reason, 200);
    perform private.notify(
      private.staff_ids(me.school_id, me.id),
      'Clase por cubrir: ' || emp.full_name, v_summary, '#/absence/' || v_id
    );
    perform private.notify(
      array[emp.id], 'Tu clase se va a cubrir',
      me.full_name || ' anotó que estarás en: ' || left(v_reason, 200) || ' (' || private.fmt_range(p_start_date, v_end)
        || '). No cuenta como ausencia.',
      '#/absence/' || v_id
    );
  else
    v_summary := private.fmt_range(p_start_date, v_end) || ' · ' || private.fmt_schedule(v_partial, v_start_time, v_end_time)
      || coalesce(' · ' || private.category_label(v_category), '');
    perform private.notify(
      private.staff_ids(me.school_id, me.id),
      'Nueva ausencia: ' || emp.full_name, v_summary, '#/absence/' || v_id
    );
    if emp.id <> me.id then
      perform private.notify(
        array[emp.id], 'Se registró una ausencia a tu nombre',
        me.full_name || ' registró tu ausencia para ' || private.fmt_range(p_start_date, v_end) || '.',
        '#/absence/' || v_id
      );
    end if;
  end if;
  insert into public.outbox (kind, school_id, payload)
  values ('teams', me.school_id, jsonb_build_object('event', 'created', 'absence_id', v_id));

  return v_id;
end;
$$;

-- Same as in 20261213000077: someone out on school work keeps getting their notices.
create or replace function private.absent_now(p_user uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    join public.absences a on a.user_id = p.id and a.status <> 'cancelled' and a.category is distinct from 'actividad'
    cross join lateral (select now() at time zone coalesce(
      (select st.time_zone from public.school_settings st where st.school_id = p.school_id), 'America/Puerto_Rico') as t) l
    where p.id = p_user
      and l.t::date between a.start_date and a.end_date
      and (not a.partial or (l.t::time >= coalesce(a.start_time, '00:00') and (a.end_time is null or l.t::time < a.end_time)))
  )
$$;

-- Same as in 20261215000079: the count of absences leaves out the activities.
create or replace view public.employees_v with (security_invoker = true) as
select p.id, p.school_id, p.role, p.username, p.full_name, p.email, p.phone, p.employee_number, p."position",
  p.active, p.must_change_password, p.last_login_at, p.created_at, p.updated_at,
  (select count(*) from public.absences a
   where a.user_id = p.id and a.status <> 'cancelled' and a.category is distinct from 'actividad')::integer as absence_count,
  p.password_help_at, p.room, p.groups,
  p.require_mfa,
  private.has_mfa(p.id) as mfa_ready,
  p.extra_roles,
  p.app_version, p.app_version_at
from public.profiles p
where p.role <> 'admin';

-- Same as in 20261030000033: classes to cover without an absence are told apart («2 ausencias · 1 en actividad de la
-- escuela (1 sin cubrir)») and «Mañana faltan» only counts absences.
create or replace function private.summary_text(j jsonb)
returns text
language sql immutable set search_path = ''
as $$
  with t as (
    select
      (select count(*) from jsonb_array_elements(j->'absences') a
       where a->>'category' is distinct from 'actividad') as absent,
      (select count(*) from jsonb_array_elements(j->'absences') a
       where a->>'category' is distinct from 'actividad'
         and (a->>'needs_cover')::boolean and jsonb_array_length(a->'covers') = 0 and a->>'no_cover' is null) as uncovered,
      (select count(*) from jsonb_array_elements(j->'absences') a where a->>'category' = 'actividad') as duty,
      (select count(*) from jsonb_array_elements(j->'absences') a
       where a->>'category' = 'actividad' and jsonb_array_length(a->'covers') = 0 and a->>'no_cover' is null) as duty_uncovered,
      (select coalesce(sum((s->>'requested')::int), 0) from jsonb_array_elements(j->'services') s) as turns,
      (select coalesce(sum((s->>'late')::int), 0) from jsonb_array_elements(j->'services') s) as late,
      (j->'maintenance'->>'open')::int as maint,
      (select count(*) from jsonb_array_elements(j->'next_absences') a
       where a->>'category' is distinct from 'actividad') as next_absent,
      (j->>'next_day')::date as next_day,
      (j->>'day')::date as day
  )
  select concat_ws(' · ',
      case when absent = 0 then 'Nadie del personal faltó'
        else absent || case when absent = 1 then ' ausencia' else ' ausencias' end
          || case when uncovered > 0 then ' (' || uncovered || ' sin cubrir)' else '' end end,
      case when duty > 0 then duty || ' en actividad de la escuela'
          || case when duty_uncovered > 0 then ' (' || duty_uncovered || ' sin cubrir)' else '' end end,
      case when turns = 0 then 'Sin turnos'
        else turns || case when turns = 1 then ' turno' else ' turnos' end
          || case when late > 0 then ' (' || late || ' no ' || case when late = 1 then 'llegó' else 'llegaron' end || ' a tiempo)' else '' end end,
      case when maint > 0 then maint || ' de mantenimiento ' || case when maint = 1 then 'pendiente' else 'pendientes' end end,
      case when next_day is not null then
        case when next_day = day + 1 then 'Mañana'
          else 'El ' || (array['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'])[extract(isodow from next_day)::int] end
        || case when next_absent = 0 then ' no falta nadie' when next_absent = 1 then ' falta 1' else ' faltan ' || next_absent end
      end) || '.'
  from t
$$;
