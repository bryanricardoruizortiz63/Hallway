-- Archivos para quien cubre: además de las instrucciones, el maestro que falta (o quien registra su ausencia) puede
-- adjuntar su plan o el material de la clase, y quien cubre lo ve y lo baja desde «Vas a cubrir». La excusa o
-- evidencia sigue siendo privada: solo la ven el empleado y la dirección.
--   * attachments.for_cover: true = para quien cubre. Los archivos que ya había son excusas.
--   * create_absence y add_attachments lo guardan con "cover": true en cada archivo (insert_attachments). Hasta 10
--     archivos a la vez (la excusa y el material, al reportar) y, como antes, 10 por ausencia.
--   * Quien tiene una fila de la cobertura (covers) puede leer esos archivos y bajarlos (el bucket deja ver los que la
--     tabla le deja ver); nunca la excusa. Si se le quita la cobertura o se cancela la ausencia, deja de verlos.
--   * add_attachments avisa a quien ya cubre cuando llega material nuevo.

alter table public.attachments add column for_cover boolean not null default false;

/** Whether I have a row of the absence's coverage (security definer: whoever covers can't read the absence). */
create or replace function private.i_cover(p_absence_id bigint)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.absences a
    where a.id = p_absence_id and a.school_id = private.my_school_id() and a.status <> 'cancelled'
      and a.covers @> jsonb_build_array(jsonb_build_object('substitute_id', (select auth.uid())))
  )
$$;

revoke execute on function private.i_cover(bigint) from public, anon;
grant execute on function private.i_cover(bigint) to authenticated;

create policy "Ver material para cubrir" on public.attachments for select to authenticated
  using (for_cover and private.i_cover(absence_id));

-- Registers uploaded files (already in the "excuses" bucket) for an absence; "cover": true is for whoever covers.
create or replace function private.insert_attachments(p_absence_id bigint, me public.profiles, p_files jsonb)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  f jsonb;
  v_path text;
  v_meta jsonb;
  n int := 0;
begin
  if jsonb_typeof(coalesce(p_files, '[]'::jsonb)) <> 'array' then
    raise exception 'Archivos no válidos.';
  end if;
  if jsonb_array_length(coalesce(p_files, '[]'::jsonb)) > 10 then
    raise exception 'Puedes subir hasta 10 archivos a la vez.';
  end if;
  for f in select * from jsonb_array_elements(coalesce(p_files, '[]'::jsonb)) loop
    v_path := f ->> 'path';
    if v_path is null or v_path not like me.school_id::text || '/' || me.id::text || '/%' then
      raise exception 'Archivo no válido.';
    end if;
    select o.metadata into v_meta from storage.objects o where o.bucket_id = 'excuses' and o.name = v_path;
    if not found then
      raise exception 'No se encontró el archivo subido. Inténtalo de nuevo.';
    end if;
    insert into public.attachments (absence_id, school_id, uploaded_by, uploaded_by_name, path, original_name, mime, size, for_cover)
    values (
      p_absence_id, me.school_id, me.id, me.full_name, v_path,
      left(coalesce(nullif(btrim(f ->> 'name'), ''), 'archivo'), 200),
      coalesce(v_meta ->> 'mimetype', 'application/octet-stream'),
      coalesce((v_meta ->> 'size')::int, 0),
      coalesce(f ->> 'cover', '') = 'true'
    );
    n := n + 1;
  end loop;
  return n;
end;
$$;

/** Adds files to an absence; material for whoever covers ("cover": true) is announced to whoever covers now. */
create or replace function public.add_attachments(p_absence_id bigint, p_files jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  a public.absences := private.load_absence(p_absence_id, me);
  n int;
  v_cover int;
  v_name text;
begin
  if a.status = 'cancelled' then
    raise exception 'La ausencia está cancelada.';
  end if;
  if (select count(*) from public.attachments where absence_id = a.id) + jsonb_array_length(coalesce(p_files, '[]')) > 10 then
    raise exception 'Máximo 10 documentos por ausencia.';
  end if;
  n := private.insert_attachments(a.id, me, p_files);
  if n = 0 then
    raise exception 'Selecciona al menos un archivo.';
  end if;
  update public.absences set updated_at = now() where id = a.id;
  perform private.notify(
    case when me.id = a.user_id then private.staff_ids(me.school_id, me.id) else array[a.user_id] end,
    'Nuevo documento en una ausencia', me.full_name || ' subió ' || n || ' archivo(s).', '#/absence/' || a.id
  );
  select count(*) into v_cover from jsonb_array_elements(coalesce(p_files, '[]')) f where coalesce(f ->> 'cover', '') = 'true';
  if v_cover > 0 then
    select full_name into v_name from public.profiles where id = a.user_id;
    perform private.notify(
      array(select distinct (c ->> 'substitute_id')::uuid from jsonb_array_elements(a.covers) c
            where c ->> 'substitute_id' is not null and c ->> 'substitute_id' <> me.id::text),
      'Material para cubrir a ' || v_name,
      me.full_name || ' subió ' || v_cover || ' archivo(s) para la clase que cubres.', '#/cover/' || a.id
    );
  end if;
end;
$$;
