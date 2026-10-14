-- Ausencias de parte del día: la hora «Hasta» ya no es opcional. create_absence y update_absence piden la hora final
-- (después de la de inicio) cuando la ausencia es de parte del día; lo demás queda igual. Las que ya se guardaron sin
-- hora final siguen como están; al modificarlas, hay que ponerla.

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
  v_id bigint;
  v_files int;
  v_summary text;
begin
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
    if me.role = 'admin' then
      raise exception 'Selecciona el empleado que va a faltar.';
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

  insert into public.absences (
    school_id, user_id, created_by, created_by_name, start_date, end_date, partial, start_time, end_time,
    category, reason, coverage_notes
  )
  values (
    me.school_id, emp.id, me.id, me.full_name, p_start_date, v_end, v_partial, v_start_time, v_end_time,
    v_category, private.clean_text(p_reason, 1000, 'La causa'),
    private.clean_text(p_coverage_notes, 1000, 'Las notas para cubrir')
  )
  returning id into v_id;

  v_files := private.insert_attachments(v_id, me, p_files);

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
  insert into public.outbox (kind, school_id, payload)
  values ('teams', me.school_id, jsonb_build_object('event', 'created', 'absence_id', v_id));

  return v_id;
end;
$$;

create or replace function public.update_absence(
  p_id bigint,
  p_start_date date,
  p_end_date date default null,
  p_partial boolean default false,
  p_start_time time default null,
  p_end_time time default null,
  p_category text default null,
  p_reason text default null,
  p_coverage_notes text default null,
  p_note text default null,
  p_today date default null
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  a public.absences := private.load_absence(p_id, me);
  v_today date := case when p_today between current_date - 1 and current_date + 1 then p_today else current_date end;
  v_partial boolean := coalesce(p_partial, false);
  v_end date;
  v_start_time time;
  v_end_time time;
  v_category text := nullif(btrim(p_category), '');
  v_reason text := private.clean_text(p_reason, 1000, 'La causa');
  v_notes text := private.clean_text(p_coverage_notes, 1000, 'Las notas para cubrir');
  v_note text := private.clean_text(p_note, 500, 'El motivo del cambio');
  v_changes jsonb := '[]'::jsonb;
  v_reopen boolean;
  v_history bigint;
  v_name text;
  v_summary text;
begin
  if a.status = 'cancelled' then
    raise exception 'La ausencia está cancelada.';
  end if;
  perform private.require_owner_or_admin(a, me, 'modificar');

  -- Same rules as create_absence.
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

  if (p_start_date, v_end) is distinct from (a.start_date, a.end_date) then
    v_changes := v_changes || jsonb_build_object(
      'label', 'Fecha', 'before', private.fmt_range(a.start_date, a.end_date), 'after', private.fmt_range(p_start_date, v_end));
  end if;
  if (v_partial, v_start_time, v_end_time) is distinct from (a.partial, a.start_time, a.end_time) then
    v_changes := v_changes || jsonb_build_object(
      'label', 'Horario',
      'before', private.fmt_schedule(a.partial, a.start_time, a.end_time),
      'after', private.fmt_schedule(v_partial, v_start_time, v_end_time));
  end if;
  if v_category is distinct from a.category then
    v_changes := v_changes || jsonb_build_object(
      'label', 'Tipo',
      'before', coalesce(private.category_label(a.category), 'No especificado'),
      'after', coalesce(private.category_label(v_category), 'No especificado'));
  end if;
  if v_reason is distinct from a.reason then
    v_changes := v_changes || jsonb_build_object('label', 'Causa', 'before', a.reason, 'after', v_reason);
  end if;
  if v_notes is distinct from a.coverage_notes then
    v_changes := v_changes || jsonb_build_object(
      'label', 'Instrucciones para cubrir', 'before', a.coverage_notes, 'after', v_notes);
  end if;
  if jsonb_array_length(v_changes) = 0 then
    raise exception 'No hiciste ningún cambio.';
  end if;

  -- A new date or time has to be confirmed again by the school.
  v_reopen := a.status = 'received'
    and (p_start_date, v_end, v_partial, v_start_time, v_end_time)
      is distinct from (a.start_date, a.end_date, a.partial, a.start_time, a.end_time);

  update public.absences
  set start_date = p_start_date, end_date = v_end, partial = v_partial, start_time = v_start_time,
      end_time = v_end_time, category = v_category, reason = v_reason, coverage_notes = v_notes,
      status = case when v_reopen then 'pending' else status end,
      received_by = case when v_reopen then null else received_by end,
      received_by_name = case when v_reopen then null else received_by_name end,
      received_at = case when v_reopen then null else received_at end,
      updated_at = now()
  where id = a.id;

  insert into public.absence_history (absence_id, school_id, actor_id, actor_name, action, changes, note)
  values (a.id, a.school_id, me.id, me.full_name, 'edited', v_changes, v_note)
  returning id into v_history;

  select full_name into v_name from public.profiles where id = a.user_id;
  v_summary := private.fmt_range(p_start_date, v_end) || ' · ' || private.fmt_schedule(v_partial, v_start_time, v_end_time)
    || case when v_reopen then ' · hay que confirmarla de nuevo' else '' end;
  perform private.notify(
    private.staff_ids(me.school_id, me.id), 'Ausencia modificada: ' || v_name, v_summary, '#/absence/' || a.id
  );
  if me.id <> a.user_id then
    perform private.notify(
      array[a.user_id], 'Tu ausencia fue modificada', me.full_name || ' la cambió: ' || v_summary, '#/absence/' || a.id
    );
  end if;
  insert into public.outbox (kind, school_id, payload)
  values ('teams', me.school_id, jsonb_build_object(
    'event', 'edited', 'absence_id', a.id, 'history_id', v_history, 'reopened', v_reopen));
end;
$$;
