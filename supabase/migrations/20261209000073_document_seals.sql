-- Documents that prove they come from Hallway. Every PDF, picture or Excel the app makes of a history (absences,
-- turns, the staff history, the reports) gets a verification code and a QR code. The database keeps, with the code,
-- who made it, when, and a copy of what it contains, built by the database itself (not by the phone). Anyone who
-- scans the QR, or types the code in Hallway › Verificar, sees that copy: if the paper says something else, it was
-- changed. A code is 12 random characters (about 59 bits): nobody can guess one.
-- The copies last one year.

create table if not exists public.document_seals (
  code text primary key check (code ~ '^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$'),
  school_id uuid not null references public.schools(id) on delete cascade,
  kind text not null check (kind in ('absences', 'turns', 'history', 'school_history', 'export')),
  format text not null check (format in ('pdf', 'image', 'excel')),
  title text not null check (char_length(title) <= 200),
  details text check (char_length(details) <= 500),
  items integer not null default 0,
  content jsonb,
  content_hash text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_by_name text not null,
  created_at timestamptz not null default now()
);
create index if not exists document_seals_school on public.document_seals (school_id, created_at desc);
-- Only through the functions below.
alter table public.document_seals enable row level security;
revoke all on public.document_seals from anon, authenticated;

/** «K7QM-3XPA-9RTD»: 12 characters without the ones that look alike (0/O, 1/I/L). */
create or replace function private.seal_code()
returns text
language plpgsql volatile set search_path = ''
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_bytes bytea := extensions.gen_random_bytes(12);
  v_out text := '';
begin
  for i in 0..11 loop
    v_out := v_out || substr(v_alphabet, (get_byte(v_bytes, i) % 31) + 1, 1);
    if i in (3, 7) then v_out := v_out || '-'; end if;
  end loop;
  return v_out;
end;
$$;

/**
 * Seals a document the app is about to make and returns its code. The content is read here, with the same
 * permissions as the screen it comes from:
 *   absences        p_ids: the chosen absences (Buscar ausencias, or Buscar mis ausencias: only one's own)
 *   turns           p_ids: the turns (Buscar turnos)
 *   history         p_user, p_from, p_to: one person's history (with the turns' records only for Admin and Director(a))
 *   school_history  p_from, p_to: the whole school's history (kept as a count and a fingerprint, it is too long)
 *   export          any other Excel (reports, panels): who downloaded what and when, with its number of rows
 */
create or replace function public.seal_document(
  p_kind text, p_format text, p_title text, p_details text default null,
  p_ids bigint[] default null, p_user uuid default null, p_from timestamptz default null, p_to timestamptz default null,
  p_items integer default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_full boolean := private.history_full(me);
  v_content jsonb;
  v_items integer;
  v_hash text;
  v_code text;
  v_at timestamptz := now();
begin
  if p_format not in ('pdf', 'image', 'excel') then raise exception 'Formato no válido.'; end if;
  if coalesce(btrim(p_title), '') = '' then raise exception 'Falta el título del documento.'; end if;
  if (select count(*) from public.document_seals d where d.created_by = me.id and d.created_at > now() - interval '1 hour') >= 200 then
    raise exception 'Se crearon muchos documentos en la última hora. Espera un poco.';
  end if;

  if p_kind = 'absences' then
    if coalesce(cardinality(p_ids), 0) = 0 or cardinality(p_ids) > 500 then raise exception 'Elige de 1 a 500 ausencias.'; end if;
    if not (private.can(me, 'absence_search') or private.can(me, 'absences')) and (
      not private.can(me, 'own_absence_search')
      or exists (select 1 from public.absences a where a.id = any(p_ids) and a.user_id <> me.id)
    ) then
      raise exception 'No tienes permiso para guardar estas ausencias.';
    end if;
    select jsonb_agg(jsonb_build_object(
        'id', a.id, 'employee_name', p.full_name, 'employee_position', p.position, 'groups', to_jsonb(p.groups),
        'start_date', a.start_date, 'end_date', a.end_date, 'partial', a.partial,
        'start_time', to_char(a.start_time, 'HH24:MI'), 'end_time', to_char(a.end_time, 'HH24:MI'),
        'status', a.status, 'category', a.category, 'reason', a.reason, 'no_cover', a.no_cover,
        'covers', (select coalesce(jsonb_agg(c ->> 'name'), '[]'::jsonb) from jsonb_array_elements(coalesce(a.covers, '[]'::jsonb)) c))
        order by a.start_date desc, p.full_name)
      into v_content
    from public.absences a join public.profiles p on p.id = a.user_id
    where a.id = any(p_ids) and a.school_id = me.school_id;
    v_items := coalesce(jsonb_array_length(v_content), 0);

  elsif p_kind = 'turns' then
    if coalesce(cardinality(p_ids), 0) = 0 or cardinality(p_ids) > 500 then raise exception 'Elige de 1 a 500 turnos.'; end if;
    if not (private.can(me, 'turn_search') or v_full) then raise exception 'No tienes permiso para guardar estos turnos.'; end if;
    select jsonb_agg(jsonb_build_object(
        'id', r.id, 'service_name', s.name, 'service_mode', s.mode, 'student_name', r.student_name, 'group_name', r.group_name,
        'room', r.room, 'severity', r.severity, 'reason', d.reason, 'status', r.status, 'outcome', r.outcome,
        'created_at', r.created_at, 'closed_at', r.closed_at, 'created_by_name', r.created_by_name,
        'handled_by_name', r.handled_by_name, 'closed_by_name', r.closed_by_name)
        order by r.created_at desc)
      into v_content
    from public.service_requests r
    join public.school_services s on s.id = r.service_id
    left join public.service_request_details d on d.request_id = r.id
    where r.id = any(p_ids) and r.school_id = me.school_id;
    v_items := coalesce(jsonb_array_length(v_content), 0);

  elsif p_kind = 'history' then
    if not private.can(me, 'history') then raise exception 'No tienes permiso para ver el historial.'; end if;
    if not exists (select 1 from public.profiles p where p.id = p_user and p.school_id = me.school_id) then
      raise exception 'Empleado no encontrado.';
    end if;
    select jsonb_agg(jsonb_build_object('at', x.at, 'actor_name', x.actor_name, 'action', x.action, 'details', x.details,
        'record', case when v_full then x.record end) order by x.at)
      into v_content
    from (
      select l.at, l.actor_name, l.action, l.details, l.record from public.activity_log l
      where l.school_id = me.school_id and (l.actor_id = p_user or l.subject_id = p_user)
        and l.at >= coalesce(p_from, now() - interval '400 days') and l.at < coalesce(p_to, now() + interval '1 day')
      order by l.at desc limit 2000
    ) x;
    v_items := coalesce(jsonb_array_length(v_content), 0);

  elsif p_kind = 'school_history' then
    if not private.can(me, 'history') then raise exception 'No tienes permiso para ver el historial.'; end if;
    select count(*), encode(sha256(convert_to(coalesce(string_agg(
        concat_ws('|', l.id, l.at, l.actor_name, l.action, l.details, case when v_full then l.record end), E'\n' order by l.at, l.id), ''), 'UTF8')), 'hex')
      into v_items, v_hash
    from public.activity_log l
    where l.school_id = me.school_id and l.at >= p_from and l.at < p_to;
    v_content := jsonb_build_object('from', p_from, 'to', p_to);

  elsif p_kind = 'export' then
    v_items := greatest(coalesce(p_items, 0), 0);
    v_content := null;

  else
    raise exception 'Tipo de documento no válido.';
  end if;

  v_hash := coalesce(v_hash, encode(sha256(convert_to(coalesce(v_content::text, '') || '|' || v_items, 'UTF8')), 'hex'));
  loop
    v_code := private.seal_code();
    exit when not exists (select 1 from public.document_seals d where d.code = v_code);
  end loop;
  insert into public.document_seals (code, school_id, kind, format, title, details, items, content, content_hash,
    created_by, created_by_name, created_at)
  values (v_code, me.school_id, p_kind, p_format, left(btrim(p_title), 200), left(nullif(btrim(p_details), ''), 500),
    v_items, v_content, v_hash, me.id, me.full_name, v_at);
  return jsonb_build_object('code', v_code, 'created_at', v_at, 'items', v_items, 'hash', left(v_hash, 12),
    'created_by_name', me.full_name);
end;
$$;
revoke execute on function public.seal_document(text, text, text, text, bigint[], uuid, timestamptz, timestamptz, integer) from public, anon;
grant execute on function public.seal_document(text, text, text, text, bigint[], uuid, timestamptz, timestamptz, integer) to authenticated;

/**
 * Anyone with the code (also without an account: it is on the paper): what Hallway kept of that document.
 * Null when the code doesn't exist (or is older than a year).
 */
create or replace function public.verify_document(p_code text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_clean text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  d public.document_seals;
begin
  if length(v_clean) <> 12 then return null; end if;
  select * into d from public.document_seals x
  where x.code = substr(v_clean, 1, 4) || '-' || substr(v_clean, 5, 4) || '-' || substr(v_clean, 9, 4);
  if not found then return null; end if;
  return jsonb_build_object(
    'code', d.code, 'kind', d.kind, 'format', d.format, 'title', d.title, 'details', d.details, 'items', d.items,
    'content', d.content, 'hash', left(d.content_hash, 12), 'created_by_name', d.created_by_name, 'created_at', d.created_at,
    'school_name', (select s.name from public.schools s where s.id = d.school_id));
end;
$$;
revoke execute on function public.verify_document(text) from public;
grant execute on function public.verify_document(text) to anon, authenticated;

/** Daily: copies older than a year are deleted. */
create or replace function private.purge_document_seals()
returns void
language sql security definer set search_path = ''
as $$
  delete from public.document_seals where created_at < now() - interval '1 year'
$$;
revoke execute on function private.purge_document_seals() from public, anon, authenticated;

select cron.unschedule('hallway-document-seals') where exists (select 1 from cron.job where jobname = 'hallway-document-seals');
select cron.schedule('hallway-document-seals', '41 6 * * *', $job$select private.purge_document_seals()$job$);
