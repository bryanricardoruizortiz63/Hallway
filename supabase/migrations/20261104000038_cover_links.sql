-- Enlaces para quien cubre: además del plan o material en archivos, el maestro que falta (o quien registra su
-- ausencia) puede dejar enlaces (un Google Doc, una presentación, un video…). Quien cubre los ve y los abre desde
-- «Vas a cubrir», y el aviso de la cobertura le dice qué material hay.
--   * cover_links: el enlace (solo http o https), un nombre opcional y quién lo dejó. Hasta 5 por ausencia. Los ven
--     quien ve la ausencia y quien la cubre (private.i_cover). Quitar uno lo deja guardado sin mostrarse (removed_at).
--   * add_cover_links avisa a quien ya cubre; remove_cover_link lo quita (quien lo dejó o quien gestiona el personal).
--   * El aviso de la cobertura (private.cover_notice_all; también los recordatorios) termina con «Material: 2
--     archivos y 1 enlace en la app» cuando hay material.

create table public.cover_links (
  id bigint generated always as identity primary key,
  absence_id bigint not null references public.absences on delete cascade,
  school_id uuid not null references public.schools on delete cascade,
  url text not null check (url ~* '^https?://[^[:space:]]+$' and char_length(url) <= 1000),
  label text check (char_length(label) <= 120),
  added_by uuid references public.profiles on delete set null,
  added_by_name text,
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by_name text
);
create index cover_links_absence on public.cover_links (absence_id);
create index cover_links_school on public.cover_links (school_id);

alter table public.cover_links enable row level security;
revoke all on public.cover_links from anon;
revoke insert, update, delete, truncate on public.cover_links from authenticated;
grant select on public.cover_links to authenticated;

create policy "Ver enlaces para cubrir" on public.cover_links for select to authenticated
  using (removed_at is null and (exists (select 1 from public.absences a where a.id = absence_id) or private.i_cover(absence_id)));

/**
 * Links for whoever covers: [{ url, label }] (label optional), up to 5 per absence, only http or https. Whoever
 * covers now gets a notice. Returns how many it saved.
 */
create or replace function public.add_cover_links(p_absence_id bigint, p_links jsonb)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  a public.absences := private.load_absence(p_absence_id, me);
  l jsonb;
  v_url text;
  n int := 0;
  v_name text;
begin
  if a.status = 'cancelled' then
    raise exception 'La ausencia está cancelada.';
  end if;
  if jsonb_typeof(coalesce(p_links, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_links, '[]'::jsonb)) = 0 then
    raise exception 'Escribe el enlace.';
  end if;
  if (select count(*) from public.cover_links where absence_id = a.id and removed_at is null) + jsonb_array_length(p_links) > 5 then
    raise exception 'Máximo 5 enlaces por ausencia.';
  end if;
  for l in select * from jsonb_array_elements(p_links) loop
    v_url := btrim(coalesce(l ->> 'url', ''));
    if v_url !~* '^https?://[^[:space:]]+$' then
      raise exception 'El enlace debe empezar con https:// (cópialo de la barra del navegador).';
    end if;
    if char_length(v_url) > 1000 then
      raise exception 'El enlace es demasiado largo.';
    end if;
    insert into public.cover_links (absence_id, school_id, url, label, added_by, added_by_name)
    values (a.id, a.school_id, v_url, private.clean_text(l ->> 'label', 120, 'El nombre del enlace'), me.id, me.full_name);
    n := n + 1;
  end loop;
  update public.absences set updated_at = now() where id = a.id;
  select full_name into v_name from public.profiles where id = a.user_id;
  perform private.notify(
    array(select distinct (c ->> 'substitute_id')::uuid from jsonb_array_elements(a.covers) c
          where c ->> 'substitute_id' is not null and c ->> 'substitute_id' <> me.id::text),
    'Material para cubrir a ' || v_name,
    me.full_name || ' dejó ' || n || ' enlace(s) para la clase que cubres.', '#/cover/' || a.id
  );
  return n;
end;
$$;

/** Takes a link away (it stays saved, no longer shown): whoever left it, or whoever manages the staff. */
create or replace function public.remove_cover_link(p_id bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  l public.cover_links;
begin
  select * into l from public.cover_links where id = p_id and school_id = me.school_id and removed_at is null;
  if l.id is null then
    raise exception 'No se encontró el enlace.';
  end if;
  perform private.load_absence(l.absence_id, me);
  if l.added_by is distinct from me.id and not private.can(me, 'staff') then
    raise exception 'Solo quien dejó el enlace puede quitarlo.';
  end if;
  update public.cover_links set removed_at = now(), removed_by_name = me.full_name where id = l.id;
end;
$$;

revoke execute on function public.add_cover_links(bigint, jsonb), public.remove_cover_link(bigint) from public, anon;
grant execute on function public.add_cover_links(bigint, jsonb), public.remove_cover_link(bigint) to authenticated;

/**
 * Everything one person covers in an absence (one or more rows): their days, hours, groups and room, the
 * instructions and how much material there is (files and links for whoever covers); never the type or the reason
 * of the absence.
 */
create or replace function private.cover_notice_all(a public.absences, p_parts jsonb)
returns text
language sql stable set search_path = ''
as $$
  select concat_ws(' · ',
    (select string_agg(concat_ws(' · ',
        private.cover_when(a, e.value),
        private.cover_schedule(a, e.value),
        private.cover_where(array(select jsonb_array_elements_text(coalesce(e.value->'groups', '[]'::jsonb))), e.value->>'room')),
      '; ' order by e.ordinality)
     from jsonb_array_elements(p_parts) with ordinality e),
    case when a.coverage_notes is not null then 'Instrucciones: «' || private.short_text(a.coverage_notes, 160) || '»' end,
    (select case when m.files + m.links > 0 then 'Material: ' || concat_ws(' y ',
        case when m.files > 0 then m.files || case when m.files = 1 then ' archivo' else ' archivos' end end,
        case when m.links > 0 then m.links || case when m.links = 1 then ' enlace' else ' enlaces' end end) || ' en la app' end
     from (select (select count(*) from public.attachments t where t.absence_id = a.id and t.for_cover) as files,
                  (select count(*) from public.cover_links k where k.absence_id = a.id and k.removed_at is null) as links) m))
$$;
