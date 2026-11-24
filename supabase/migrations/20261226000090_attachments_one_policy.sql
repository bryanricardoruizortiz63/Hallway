-- Supabase's performance advisor: public.attachments had two permissive SELECT policies for authenticated
-- («Ver documentos» and «Ver material para cubrir»), so Postgres evaluated both for every row. One policy with the same
-- two conditions joined by OR lets the same people see the same files, and is checked once.
--   · Ver documentos: the absence is one this person may see (the absences' own RLS decides).
--   · Ver material para cubrir: material marked for whoever covers, and this person covers that absence.

drop policy if exists "Ver documentos" on public.attachments;
drop policy if exists "Ver material para cubrir" on public.attachments;
drop policy if exists "Ver documentos y material para cubrir" on public.attachments;

create policy "Ver documentos y material para cubrir" on public.attachments for select to authenticated using (
  exists (select 1 from public.absences a where a.id = attachments.absence_id)
  or (for_cover and private.i_cover(absence_id))
);
