-- Formulario del turno: what the service writes down when it attends a student (Enfermería: what the student felt,
-- the vital signs, what was done…). Like a clinic's form, but never required: the app tells what is empty and asks
-- whether to save anyway.
--
-- · Each service has its own fields (school_services.form_fields). Whoever has «Configurar Turnos» (the Admin among
--   them) adds, changes, orders or removes them at any time. Enfermería starts with a set of usual fields.
-- · Field types: text · long (several lines) · number (with its unit) · check_number («Se tomó el azúcar» and then only
--   the number) · pressure («Se tomó la presión» and then the two numbers) · choices (tap the ones that apply) · yesno.
-- · What is written for a turn (service_request_forms) is only for whoever attends the service and whoever sees every
--   turn's detail (Admin, «Ver el detalle de los turnos»): not for the teacher. It keeps the fields as they were when
--   it was written, so changing the form later doesn't change old records, and it stays if the turn is deleted.

alter table public.school_services add column if not exists form_fields jsonb not null default '[]'::jsonb;

/** Enfermería's usual fields. */
create or replace function private.nursing_form_fields()
returns jsonb
language sql immutable set search_path = ''
as $$
  select '[
    {"key": "sintomas", "label": "Síntomas", "type": "choices", "options": ["Dolor de cabeza", "Fiebre", "Dolor de estómago", "Náuseas o vómito", "Mareo", "Herida o golpe", "Alergia", "Asma o falta de aire", "Dolor de muela", "Otro"]},
    {"key": "relato", "label": "Lo que contó el estudiante", "type": "long"},
    {"key": "temperatura", "label": "Temperatura", "type": "check_number", "unit": "°F"},
    {"key": "presion", "label": "Presión arterial", "type": "pressure", "unit": "mmHg"},
    {"key": "azucar", "label": "Azúcar (glucosa)", "type": "check_number", "unit": "mg/dL"},
    {"key": "pulso", "label": "Pulso", "type": "check_number", "unit": "lpm"},
    {"key": "oxigeno", "label": "Oxígeno (SpO₂)", "type": "check_number", "unit": "%"},
    {"key": "tratamiento", "label": "Qué se hizo", "type": "long"},
    {"key": "medicamento", "label": "Medicamento dado (nombre y dosis)", "type": "text"},
    {"key": "encargado", "label": "Se llamó al encargado", "type": "yesno"}
  ]'::jsonb
$$;

update public.school_services set form_fields = private.nursing_form_fields()
where form_fields = '[]'::jsonb and name ilike 'enfermer%';

-- A new Enfermería (a new school, or one added later) starts with them too.
create or replace function private.service_default_form()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.form_fields = '[]'::jsonb and new.name ilike 'enfermer%' then
    new.form_fields := private.nursing_form_fields();
  end if;
  return new;
end;
$$;
drop trigger if exists school_services_default_form on public.school_services;
create trigger school_services_default_form before insert on public.school_services
for each row execute function private.service_default_form();

/** The fields as they come from the app, checked and cleaned: at most 30, each with a key, a label and a known type. */
create or replace function private.clean_form_fields(p_fields jsonb)
returns jsonb
language plpgsql volatile set search_path = ''
as $$
declare
  f jsonb;
  v_out jsonb := '[]'::jsonb;
  v_keys text[] := '{}';
  v_key text;
  v_label text;
  v_type text;
  v_options jsonb;
begin
  if p_fields is null or jsonb_typeof(p_fields) <> 'array' then raise exception 'La lista de campos no es válida.'; end if;
  if jsonb_array_length(p_fields) > 30 then raise exception 'El formulario puede tener hasta 30 campos.'; end if;
  for f in select e.value from jsonb_array_elements(p_fields) e loop
    if jsonb_typeof(f) <> 'object' then raise exception 'La lista de campos no es válida.'; end if;
    v_label := btrim(regexp_replace(coalesce(f->>'label', ''), '\s+', ' ', 'g'));
    if v_label = '' then raise exception 'Cada campo necesita un nombre.'; end if;
    if char_length(v_label) > 60 then raise exception 'El nombre «%» es muy largo (máx. 60).', left(v_label, 20); end if;
    v_type := f->>'type';
    if v_type is null or v_type not in ('text', 'long', 'number', 'check_number', 'pressure', 'choices', 'yesno') then
      raise exception 'Tipo de campo no válido en «%».', v_label;
    end if;
    -- The key never changes once a field exists, so old records keep their values; a new field gets one from its label.
    v_key := lower(coalesce(nullif(f->>'key', ''), 'c_' || substr(md5(v_label || clock_timestamp()::text), 1, 8)));
    if v_key !~ '^[a-z0-9_]{1,40}$' then raise exception 'Campo no válido: «%».', v_label; end if;
    if v_key = any(v_keys) then raise exception 'Hay dos campos iguales: «%».', v_label; end if;
    v_keys := v_keys || v_key;
    v_options := '[]'::jsonb;
    if v_type = 'choices' then
      -- In the order written, without blanks or repeats.
      v_options := coalesce((
        select jsonb_agg(o order by ord) from (
          select distinct on (lower(btrim(x))) btrim(x) as o, ord
          from jsonb_array_elements_text(coalesce(f->'options', '[]'::jsonb)) with ordinality as t(x, ord)
          where btrim(x) <> ''
          order by lower(btrim(x)), ord
        ) u), '[]'::jsonb);
      if jsonb_array_length(v_options) = 0 then raise exception 'Escribe las opciones de «%».', v_label; end if;
      if jsonb_array_length(v_options) > 20 then raise exception '«%» puede tener hasta 20 opciones.', v_label; end if;
      if exists (select 1 from jsonb_array_elements_text(v_options) o where char_length(o) > 40) then
        raise exception 'Una opción de «%» es muy larga (máx. 40).', v_label;
      end if;
    end if;
    v_out := v_out || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'key', v_key, 'label', v_label, 'type', v_type,
      'unit', case when v_type in ('number', 'check_number', 'pressure') then nullif(left(btrim(coalesce(f->>'unit', '')), 12), '') end,
      'options', case when v_type = 'choices' then v_options end)));
  end loop;
  return v_out;
end;
$$;

/** Whoever has «Configurar Turnos» changes a service's form. Returns the fields as saved. */
create or replace function public.set_service_form(p_service bigint, p_fields jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  s public.school_services;
  v_fields jsonb := private.clean_form_fields(p_fields);
begin
  if not private.can(me, 'services') then raise exception 'No tienes permiso para configurar los servicios.'; end if;
  select * into s from public.school_services x where x.id = p_service and x.school_id = me.school_id for update;
  if s.id is null then raise exception 'No se encontró el servicio.'; end if;
  update public.school_services set form_fields = v_fields where id = s.id;
  perform private.log_activity(me.school_id, me.id, 'Cambió el formulario de ' || s.name,
    private.hist_list_change('Campos',
      array(select e->>'label' from jsonb_array_elements(s.form_fields) e),
      array(select e->>'label' from jsonb_array_elements(v_fields) e)),
    '#/services/' || s.id || '/form', null);
  return v_fields;
end;
$$;
revoke execute on function public.set_service_form(bigint, jsonb) from public, anon;
grant execute on function public.set_service_form(bigint, jsonb) to authenticated;

-- ---- What is written for each turn ------------------------------------------------------------------------------

create table if not exists public.service_request_forms (
  id bigint generated always as identity primary key,
  request_id bigint unique references public.service_requests (id) on delete set null,
  school_id uuid not null references public.schools (id) on delete cascade,
  service_id bigint not null,
  student_name text,
  group_name text,
  turn_day date not null,
  fields jsonb not null,
  data jsonb not null default '{}'::jsonb,
  filled_by uuid,
  filled_by_name text not null,
  created_at timestamptz not null default now(),
  updated_by_name text,
  updated_at timestamptz
);
create index if not exists service_request_forms_service on public.service_request_forms (service_id, turn_day);

alter table public.service_request_forms enable row level security;
revoke all on public.service_request_forms from anon, authenticated;
grant select on public.service_request_forms to authenticated;
drop policy if exists "Formulario del turno" on public.service_request_forms;
create policy "Formulario del turno" on public.service_request_forms for select to authenticated using (
  school_id = (select private.my_school_id())
  and (private.serves(service_id)
    or coalesce((select private.history_full(p) from public.profiles p where p.id = (select auth.uid()) and p.active), false))
);

/** A value as the field takes it, or null when it's empty. Numbers must be numbers in a sensible range. */
create or replace function private.clean_form_value(f jsonb, v jsonb)
returns jsonb
language plpgsql immutable set search_path = ''
as $$
declare
  t text := f->>'type';
  n numeric;
  a numeric;
  b numeric;
  v_text text;
  v_list jsonb;
begin
  if v is null or v = 'null'::jsonb then return null; end if;
  if t in ('text', 'long') then
    v_text := btrim(v #>> '{}');
    if v_text = '' then return null; end if;
    if char_length(v_text) > (case when t = 'text' then 200 else 2000 end) then
      raise exception '«%» es muy largo.', f->>'label';
    end if;
    return to_jsonb(v_text);
  elsif t = 'number' then
    if btrim(v #>> '{}') = '' then return null; end if;
    begin n := (v #>> '{}')::numeric; exception when others then raise exception '«%» debe ser un número.', f->>'label'; end;
    if n < -1000 or n > 100000 then raise exception '«%» no es un número válido.', f->>'label'; end if;
    return to_jsonb(n);
  elsif t = 'check_number' then
    if jsonb_typeof(v) <> 'object' or coalesce((v->>'taken')::boolean, false) = false then return null; end if;
    if nullif(btrim(coalesce(v->>'value', '')), '') is null then return jsonb_build_object('taken', true); end if;
    begin n := (v->>'value')::numeric; exception when others then raise exception '«%» debe ser un número.', f->>'label'; end;
    if n < 0 or n > 10000 then raise exception '«%» no es un número válido.', f->>'label'; end if;
    return jsonb_build_object('taken', true, 'value', n);
  elsif t = 'pressure' then
    if jsonb_typeof(v) <> 'object' or coalesce((v->>'taken')::boolean, false) = false then return null; end if;
    begin
      a := nullif(btrim(coalesce(v->>'sys', '')), '')::numeric;
      b := nullif(btrim(coalesce(v->>'dia', '')), '')::numeric;
    exception when others then raise exception '«%» debe tener números.', f->>'label'; end;
    if a is not null and (a < 30 or a > 300) or b is not null and (b < 20 or b > 200) then
      raise exception '«%» no tiene números válidos.', f->>'label';
    end if;
    return jsonb_strip_nulls(jsonb_build_object('taken', true, 'sys', a, 'dia', b));
  elsif t = 'choices' then
    if jsonb_typeof(v) <> 'array' then return null; end if;
    v_list := coalesce((select jsonb_agg(x) from jsonb_array_elements_text(v) x
      where x in (select jsonb_array_elements_text(f->'options'))), '[]'::jsonb);
    return case when jsonb_array_length(v_list) = 0 then null else v_list end;
  elsif t = 'yesno' then
    if jsonb_typeof(v) <> 'boolean' then return null; end if;
    return v;
  end if;
  return null;
end;
$$;

/**
 * Saves the form of a turn (only whoever attends the service). Nothing is required: empty fields are simply left out.
 * Returns the saved row.
 */
create or replace function public.save_turn_form(p_id bigint, p_data jsonb)
returns public.service_request_forms
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  r public.service_requests;
  s public.school_services;
  f jsonb;
  v jsonb;
  v_data jsonb := '{}'::jsonb;
  v_row public.service_request_forms;
  v_new boolean;
begin
  select * into r from public.service_requests x where x.id = p_id and x.school_id = me.school_id;
  if r.id is null then raise exception 'No se encontró el turno.'; end if;
  select * into s from public.school_services x where x.id = r.service_id;
  if not (private.roles_of(me) && s.roles) then raise exception 'Solo % llena este formulario.', s.name; end if;
  if jsonb_array_length(s.form_fields) = 0 then raise exception '% no tiene formulario.', s.name; end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then raise exception 'El formulario no es válido.'; end if;
  for f in select e.value from jsonb_array_elements(s.form_fields) e loop
    v := private.clean_form_value(f, p_data -> (f->>'key'));
    if v is not null then v_data := v_data || jsonb_build_object(f->>'key', v); end if;
  end loop;

  select * into v_row from public.service_request_forms x where x.request_id = r.id;
  v_new := v_row.id is null;
  if v_new then
    insert into public.service_request_forms
      (request_id, school_id, service_id, student_name, group_name, turn_day, fields, data, filled_by, filled_by_name)
    values (r.id, r.school_id, r.service_id, r.student_name, r.group_name,
      (r.created_at at time zone 'America/Puerto_Rico')::date, s.form_fields, v_data, me.id, me.full_name)
    returning * into v_row;
  else
    update public.service_request_forms
    set fields = s.form_fields, data = v_data, updated_by_name = me.full_name, updated_at = now()
    where id = v_row.id returning * into v_row;
  end if;
  -- In the history, that it was filled in: never what it says.
  perform private.log_activity(me.school_id, me.id,
    case when v_new then 'Llenó el formulario de ' else 'Corrigió el formulario de ' end || s.name,
    'Turno del ' || to_char((r.created_at at time zone 'America/Puerto_Rico')::date, 'DD/MM/YYYY'),
    '#/turns/' || r.id, null);
  return v_row;
end;
$$;
revoke execute on function public.save_turn_form(bigint, jsonb) from public, anon;
grant execute on function public.save_turn_form(bigint, jsonb) to authenticated;

-- Same as before, with each service's form fields (the app shows the form to whoever attends the service).
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
