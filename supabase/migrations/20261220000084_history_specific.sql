-- Historial del personal, más específico: cada cambio dice qué cambió, cómo estaba y cómo quedó. Hasta ahora varias
-- líneas solo decían que algo cambió («Actualizó sus datos», «Cambió la configuración de la escuela: horario de
-- clases», «Cambió quién cubre…» con solo la lista nueva).
--   * Datos de una persona (lo que cambia en la app): nombre, puesto, correo, teléfono, salón y grupos, uno por uno.
--   * Ausencias: fechas y horario, tipo, causa e instrucciones para cubrir en una sola línea; quién cubre dice a quién
--     se añadió, a quién se quitó y cómo quedó (grupos, horas, días).
--   * Configuración de la escuela: cada cosa con su antes y después (horario, días, grupos, Teams, correo, reservas…).
--   * Servicios de turnos: nombre, cómo funciona, minutos para llegar, roles, motivos, horas y si sigue abierto.
-- Los cambios que hace el servidor en la ficha (Personal › una persona) los describe la función admin.

/** «Etiqueta: «antes» → «después»», or null when it didn't change. Empty shows as «—». */
create or replace function private.hist_change(p_label text, p_old text, p_new text)
returns text
language sql immutable set search_path = ''
as $$
  select case when coalesce(p_old, '') is distinct from coalesce(p_new, '') then
    p_label || ': ' || coalesce('«' || nullif(btrim(p_old), '') || '»', '—') || ' → ' || coalesce('«' || nullif(btrim(p_new), '') || '»', '—')
  end
$$;

/** «Etiqueta: añadió a, b; quitó c», or null when the lists have the same items. */
create or replace function private.hist_list_change(p_label text, p_old text[], p_new text[])
returns text
language sql immutable set search_path = ''
as $$
  with a as (select array(select x from unnest(coalesce(p_new, '{}')) x where x <> all (coalesce(p_old, '{}')) order by 1) as added,
                    array(select x from unnest(coalesce(p_old, '{}')) x where x <> all (coalesce(p_new, '{}')) order by 1) as removed)
  select case when cardinality(added) + cardinality(removed) > 0 then
    p_label || ': ' || concat_ws('; ',
      case when cardinality(added) > 0 then 'añadió ' || array_to_string(added, ', ') end,
      case when cardinality(removed) > 0 then 'quitó ' || array_to_string(removed, ', ') end)
  end
  from a
$$;

/** One person covering, in a few words: «Ana Torres (9-C · 11:50–12:50 · lun, mié)». */
create or replace function private.hist_cover(c jsonb)
returns text
language sql immutable set search_path = ''
as $$
  select coalesce(c ->> 'name', 'alguien') || coalesce(' (' || nullif(concat_ws(' · ',
      nullif(array_to_string(array(select jsonb_array_elements_text(coalesce(c -> 'groups', '[]'::jsonb))), ', '), ''),
      case when c ->> 'start_time' is not null then left(c ->> 'start_time', 5) || coalesce('–' || left(c ->> 'end_time', 5), '') end,
      'salón ' || nullif(c ->> 'room', ''),
      nullif(array_to_string(array(select jsonb_array_elements_text(coalesce(c -> 'days', '[]'::jsonb))), ', '), '')), '') || ')', '')
$$;

/** Who covers, before and after: who was added, who was removed and how it ended up. */
create or replace function private.hist_covers(p_old jsonb, p_new jsonb, p_old_none text, p_new_none text)
returns text
language sql immutable set search_path = ''
as $$
  with o as (select coalesce(array_agg(private.hist_cover(x) order by 1), '{}') as l from jsonb_array_elements(coalesce(p_old, '[]'::jsonb)) x),
       n as (select coalesce(array_agg(private.hist_cover(x) order by 1), '{}') as l from jsonb_array_elements(coalesce(p_new, '[]'::jsonb)) x),
       d as (select array(select v from unnest(n.l) v where v <> all (o.l)) as added, array(select v from unnest(o.l) v where v <> all (n.l)) as removed
             from o, n)
  select concat_ws('. ',
    case when p_new_none is not null and p_old_none is null then 'Nadie cubrirá' || coalesce(': ' || nullif(p_new_none, ''), '') end,
    case when p_old_none is not null and p_new_none is null then 'Ya no dice que nadie cubrirá' end,
    case when cardinality(d.added) > 0 then 'Añadió: ' || array_to_string(d.added, '; ') end,
    case when cardinality(d.removed) > 0 then 'Quitó: ' || array_to_string(d.removed, '; ') end,
    case when cardinality(n.l) > 0 then 'Ahora cubren: ' || array_to_string(n.l, '; ') end) || '.'
  from d, n
$$;

-- Same as in 20261127000061, more specific.
create or replace function private.log_absence()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_name text;
  a public.absences := coalesce(new, old);
  v_who text;
  v_changes text[];
begin
  select p.full_name into v_name from public.profiles p where p.id = a.user_id;
  v_who := case when v_actor = a.user_id then 'su ausencia' else 'la ausencia de ' || coalesce(v_name, 'un empleado') end;
  if tg_op = 'INSERT' then
    perform private.log_activity(a.school_id, v_actor,
      case when v_actor = a.user_id then 'Reportó una ausencia' else 'Registró la ausencia de ' || coalesce(v_name, 'un empleado') end,
      concat_ws(' · ', private.absence_when(a), private.category_label(a.category)), '#/absence/' || a.id, a.user_id);
  elsif tg_op = 'DELETE' then
    -- The yearly archive deletes them from the server: that is logged once, by whoever did it.
    if v_actor is not null then
      perform private.log_activity(a.school_id, v_actor, 'Borró ' || v_who, private.absence_when(a), null, a.user_id);
    end if;
  else
    if new.status = 'cancelled' and old.status <> 'cancelled' then
      perform private.log_activity(a.school_id, v_actor, 'Canceló ' || v_who, private.absence_when(a), '#/absence/' || a.id, a.user_id);
    elsif new.status = 'received' and old.status <> 'received' then
      perform private.log_activity(a.school_id, v_actor, 'Confirmó el recibo de ' || v_who, private.absence_when(a), '#/absence/' || a.id, a.user_id);
    end if;
    v_changes := array_remove(array[
      case when (new.start_date, new.end_date, new.partial, new.start_time, new.end_time)
         is distinct from (old.start_date, old.end_date, old.partial, old.start_time, old.end_time)
        then 'Fecha y horario: ' || private.absence_when(old) || ' → ' || private.absence_when(new) end,
      private.hist_change('Tipo', private.category_label(old.category), private.category_label(new.category)),
      case when new.reason is distinct from old.reason
        then case when a.category = 'actividad' then private.hist_change('Dónde estará', old.reason, new.reason) else 'Cambió la causa' end end,
      private.hist_change('Instrucciones para cubrir', left(old.coverage_notes, 200), left(new.coverage_notes, 200))
    ], null);
    if cardinality(v_changes) > 0 then
      perform private.log_activity(a.school_id, v_actor, 'Modificó ' || v_who, array_to_string(v_changes, ' · '), '#/absence/' || a.id, a.user_id);
    end if;
    if new.covers is distinct from old.covers or new.no_cover is distinct from old.no_cover then
      perform private.log_activity(a.school_id, v_actor, 'Cambió quién cubre ' || v_who,
        private.hist_covers(old.covers, new.covers, old.no_cover, new.no_cover), '#/absence/' || a.id, a.user_id);
    end if;
  end if;
  return null;
end;
$$;

-- Same as in 20261127000061, with each change and how it was before.
create or replace function private.log_settings()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_what text[];
  v_days text[] := array['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];
begin
  if v_actor is null then return null; end if;
  v_what := array_remove(array[
    case when new.teams_enabled is distinct from old.teams_enabled then case when new.teams_enabled then 'Activó Teams' else 'Apagó Teams' end end,
    case when new.teams_webhook_url is distinct from old.teams_webhook_url
      then case when new.teams_webhook_url is null then 'Quitó el canal de Teams de las ausencias' else 'Cambió el canal de Teams de las ausencias' end end,
    case when new.teams_password_webhook_url is distinct from old.teams_password_webhook_url
      then case when new.teams_password_webhook_url is null then 'Quitó el canal de Teams de las contraseñas' else 'Cambió el canal de Teams de las contraseñas' end end,
    case when new.teams_include_reason is distinct from old.teams_include_reason
      then case when new.teams_include_reason then 'Teams muestra la causa de la ausencia' else 'Teams ya no muestra la causa de la ausencia' end end,
    private.hist_change('Asunto del mensaje de bienvenida', old.welcome_subject, new.welcome_subject),
    case when new.welcome_body is distinct from old.welcome_body then 'Cambió el texto del mensaje de bienvenida' end,
    private.hist_change('Horario de clases', to_char(old.day_start, 'HH24:MI') || '–' || to_char(old.day_end, 'HH24:MI'),
      to_char(new.day_start, 'HH24:MI') || '–' || to_char(new.day_end, 'HH24:MI')),
    private.hist_change('Días de clase',
      (select string_agg(v_days[d], ', ' order by d) from unnest(old.school_days) d),
      (select string_agg(v_days[d], ', ' order by d) from unnest(new.school_days) d)),
    private.hist_list_change('Grados y grupos', old.groups, new.groups),
    private.hist_change('Zona horaria', old.time_zone, new.time_zone),
    private.hist_change('Horario de reservas', to_char(old.room_start, 'HH24:MI') || '–' || to_char(old.room_end, 'HH24:MI'),
      to_char(new.room_start, 'HH24:MI') || '–' || to_char(new.room_end, 'HH24:MI')),
    private.hist_change('Nombre del salón de reservas', old.room_name, new.room_name),
    private.hist_change('Cuenta de correo', old.email_provider, new.email_provider),
    private.hist_change('Correo que envía', old.email_from, new.email_from),
    private.hist_change('Nombre que envía', old.email_from_name, new.email_from_name),
    case when (new.smtp_host, new.smtp_port, new.smtp_user, new.email_secret_id) is distinct from (old.smtp_host, old.smtp_port, old.smtp_user, old.email_secret_id)
      then 'Cambió los datos de conexión del correo' end,
    case when new.urgent_repeat is distinct from old.urgent_repeat then 'Cambió cuánto se repiten los avisos urgentes' end
  ], null);
  -- Only what a person changes (not the status of the last email or Teams message the app sent).
  if cardinality(v_what) = 0 then return null; end if;
  perform private.log_activity(new.school_id, v_actor, 'Cambió la configuración de la escuela', array_to_string(v_what, ' · '), null, null);
  return null;
end;
$$;

/** How a service works, in words (as in Configurar Turnos). */
create or replace function private.service_mode_label(m text)
returns text
language sql immutable set search_path = ''
as $$
  select case m when 'visit' then 'el estudiante va a la oficina' when 'room' then 'el profesional va al salón'
    when 'either' then 'decide quien atiende' when 'support' then 'ayuda al personal' else m end
$$;

-- Same as in 20261125000059, with each change and how it was before.
create or replace function private.log_service()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  s public.school_services := coalesce(new, old);
  v_roles_old text[];
  v_roles_new text[];
begin
  if tg_op = 'UPDATE' then
    select array_agg(coalesce(r.name, k) order by 1) into v_roles_old
    from unnest(old.roles) k left join public.school_roles r on r.school_id = s.school_id and r.key = k;
    select array_agg(coalesce(r.name, k) order by 1) into v_roles_new
    from unnest(new.roles) k left join public.school_roles r on r.school_id = s.school_id and r.key = k;
  end if;
  perform private.log_activity(s.school_id, auth.uid(),
    case tg_op when 'INSERT' then 'Creó el servicio ' when 'DELETE' then 'Borró el servicio ' else 'Cambió el servicio ' end || s.name,
    case when tg_op = 'UPDATE' then nullif(concat_ws(' · ',
      private.hist_change('Nombre', old.name, new.name),
      private.hist_change('Cómo funciona', private.service_mode_label(old.mode), private.service_mode_label(new.mode)),
      private.hist_change('Minutos para llegar', old.arrive_minutes::text, new.arrive_minutes::text),
      case when new.keep_open <> old.keep_open then case when new.keep_open then 'Los turnos siguen abiertos al día siguiente' else 'Los turnos se cierran al final del día' end end,
      case when new.active <> old.active then case when new.active then 'Lo activó' else 'Lo desactivó' end end,
      private.hist_list_change('Quién atiende', v_roles_old, v_roles_new),
      private.hist_list_change('Motivos', old.reasons, new.reasons),
      private.hist_change('Horas', to_char(old.open_from, 'HH24:MI') || '–' || to_char(old.open_until, 'HH24:MI'),
        to_char(new.open_from, 'HH24:MI') || '–' || to_char(new.open_until, 'HH24:MI'))), '')
    else concat_ws(' · ', private.service_mode_label(s.mode), 'atienden: ' || (
      select string_agg(coalesce(r.name, k), ', ') from unnest(s.roles) k
      left join public.school_roles r on r.school_id = s.school_id and r.key = k)) end,
    '#/services/' || s.id, null);
  return null;
end;
$$;

-- Same as in 20261125000059: each field that changed, how it was and how it is now.
create or replace function private.log_profile()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_changes text[];
begin
  if v_actor is null then return null; end if;
  v_changes := array_remove(array[
    private.hist_change('Nombre', old.full_name, new.full_name),
    private.hist_change('Puesto', old.position, new.position),
    private.hist_change('Correo', old.email, new.email),
    private.hist_change('Teléfono', old.phone, new.phone)
  ], null);
  if cardinality(v_changes) > 0 then
    perform private.log_activity(new.school_id, v_actor,
      case when v_actor = new.id then 'Actualizó sus datos' else 'Actualizó los datos de ' || new.full_name end,
      array_to_string(v_changes, ' · '), null, new.id);
  end if;
  if new.room is distinct from old.room or new.groups is distinct from old.groups then
    perform private.log_activity(new.school_id, v_actor,
      case when v_actor = new.id then 'Cambió su salón o sus grupos' else 'Cambió el salón o los grupos de ' || new.full_name end,
      concat_ws(' · ', private.hist_change('Salón', old.room, new.room), private.hist_list_change('Grupos', old.groups, new.groups)),
      null, new.id);
  end if;
  if new.language is distinct from old.language then
    perform private.log_activity(new.school_id, v_actor, 'Cambió el idioma de la app',
      case old.language when 'en' then 'English' else 'Español' end || ' → ' || case new.language when 'en' then 'English' else 'Español' end, null, new.id);
  end if;
  return null;
end;
$$;
