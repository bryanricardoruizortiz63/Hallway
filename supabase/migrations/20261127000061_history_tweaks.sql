-- History: absences deleted by the server (the yearly archive) are logged once by the function that did it, not
-- one line each; and changes to the school's settings (name, Teams, email, schedule, groups, welcome message).

-- Same as in 20261125000059, without the server's own deletions.
create or replace function private.log_absence()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_name text;
  a public.absences := coalesce(new, old);
  v_who text;
begin
  select p.full_name into v_name from public.profiles p where p.id = a.user_id;
  v_who := case when v_actor = a.user_id then 'su ausencia' else 'la ausencia de ' || coalesce(v_name, 'un empleado') end;
  if tg_op = 'INSERT' then
    perform private.log_activity(a.school_id, v_actor,
      case when v_actor = a.user_id then 'Reportó una ausencia' else 'Registró la ausencia de ' || coalesce(v_name, 'un empleado') end,
      private.absence_when(a), '#/absence/' || a.id, a.user_id);
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
    if (new.start_date, new.end_date, new.partial, new.start_time, new.end_time)
       is distinct from (old.start_date, old.end_date, old.partial, old.start_time, old.end_time) then
      perform private.log_activity(a.school_id, v_actor, 'Modificó ' || v_who,
        'Antes: ' || private.absence_when(old) || '. Ahora: ' || private.absence_when(new) || '.', '#/absence/' || a.id, a.user_id);
    end if;
    if new.covers is distinct from old.covers or new.no_cover is distinct from old.no_cover then
      perform private.log_activity(a.school_id, v_actor, 'Cambió quién cubre ' || v_who,
        case when new.no_cover is not null then 'Nadie cubrirá.'
          else nullif(concat_ws(', ', (select string_agg(distinct x ->> 'name', ', ') from jsonb_array_elements(coalesce(new.covers, '[]'::jsonb)) x)), '') end,
        '#/absence/' || a.id, a.user_id);
    end if;
  end if;
  return null;
end;
$$;

create or replace function private.log_settings()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_what text[];
begin
  if v_actor is null then return null; end if;
  v_what := array_remove(array[
    case when (to_jsonb(new) -> 'teams_webhook_url', to_jsonb(new) -> 'teams_password_webhook_url', to_jsonb(new) -> 'teams_enabled')
      is distinct from (to_jsonb(old) -> 'teams_webhook_url', to_jsonb(old) -> 'teams_password_webhook_url', to_jsonb(old) -> 'teams_enabled')
      then 'Teams' end,
    case when (to_jsonb(new) -> 'welcome_subject', to_jsonb(new) -> 'welcome_body')
      is distinct from (to_jsonb(old) -> 'welcome_subject', to_jsonb(old) -> 'welcome_body') then 'mensaje de bienvenida' end,
    case when (to_jsonb(new) -> 'day_start', to_jsonb(new) -> 'day_end', to_jsonb(new) -> 'school_days')
      is distinct from (to_jsonb(old) -> 'day_start', to_jsonb(old) -> 'day_end', to_jsonb(old) -> 'school_days') then 'horario de clases' end,
    case when to_jsonb(new) -> 'groups' is distinct from to_jsonb(old) -> 'groups' then 'grados y grupos' end,
    case when (to_jsonb(new) -> 'email_provider', to_jsonb(new) -> 'email_from')
      is distinct from (to_jsonb(old) -> 'email_provider', to_jsonb(old) -> 'email_from') then 'cuenta de correo' end
  ], null);
  -- Only what a person changes (not the status of the last email or Teams message the app sent).
  if cardinality(v_what) = 0 then return null; end if;
  perform private.log_activity(new.school_id, v_actor, 'Cambió la configuración de la escuela', array_to_string(v_what, ', '), null, null);
  return null;
end;
$$;
drop trigger if exists school_settings_log on public.school_settings;
create trigger school_settings_log after update on public.school_settings for each row execute function private.log_settings();
