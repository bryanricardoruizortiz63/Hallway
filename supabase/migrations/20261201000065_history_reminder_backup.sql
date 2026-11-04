-- The reminder says why the history is deleted: to keep a backup and not fill the database.
create or replace function private.history_year_job()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_now timestamp := now() at time zone 'America/Puerto_Rico';
  v_end date := make_date(extract(year from v_now)::int, 6, 30);
  v_left text;
  v_tag text;
  s record;
begin
  delete from public.activity_log where at < private.history_year_cut();

  if extract(hour from v_now) < 8 then return; end if;
  v_left := case v_now::date
    when v_end - 30 then 'Falta 1 mes' when v_end - 14 then 'Faltan 2 semanas' when v_end - 7 then 'Falta 1 semana'
    when v_end - 1 then 'Falta 1 día'
    else null end;
  if v_left is null then return; end if;
  v_tag := 'history-year-' || to_char(v_now, 'YYYY-MM-DD');
  for s in select x.id from public.schools x where x.active loop
    if exists (select 1 from public.notifications n join public.profiles p on p.id = n.user_id
               where p.school_id = s.id and n.tag = v_tag) then
      continue;
    end if;
    perform private.notify_tagged(
      array(select p.id from public.profiles p where p.school_id = s.id and p.active and private.history_full(p)),
      '📥 Descarga el historial del año escolar',
      format('%s: el 30 de junio termina el año escolar y el 1 de julio se borra el historial del personal y el récord de los turnos, para no llenar la base de datos. Descárgalo antes como respaldo (backup) en Más › Historial del personal.', v_left),
      '#/history', v_tag, false);
  end loop;
end;
$$;
