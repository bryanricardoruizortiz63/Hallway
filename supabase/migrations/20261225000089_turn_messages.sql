-- Mensajes de un turno: a private chat for one turn between whoever attends the service and whoever asked for it (or has
-- the student now). Also the note when the service calls the student («Que traiga su inhalador») and the reason when a
-- turn is cancelled, so the teacher knows why. Kept for good: nobody can edit or delete a message, and they stay even if
-- the turn is deleted when a service closes its school year (with the student, the service and the day).
--
-- Who reads them: the author, whoever attends the service, whoever asked for the turn, whoever has the student now, and
-- whoever sees every turn's detail (Admin, «Ver el detalle de los turnos»).

create table if not exists public.service_request_messages (
  id bigint generated always as identity primary key,
  request_id bigint references public.service_requests (id) on delete set null,
  school_id uuid not null references public.schools (id) on delete cascade,
  service_id bigint not null,
  requester_id uuid,
  student_name text,
  turn_day date not null,
  author_id uuid,
  author_name text not null,
  author_side text not null check (author_side in ('service', 'teacher')),
  kind text not null default 'message' check (kind in ('message', 'call', 'cancel')),
  body text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index if not exists service_request_messages_request on public.service_request_messages (request_id, id);
create index if not exists service_request_messages_school on public.service_request_messages (school_id, created_at);

alter table public.service_request_messages enable row level security;
revoke all on public.service_request_messages from anon, authenticated;
grant select on public.service_request_messages to authenticated;

drop policy if exists "Mensajes del turno" on public.service_request_messages;
create policy "Mensajes del turno" on public.service_request_messages for select to authenticated using (
  school_id = (select private.my_school_id())
  and (
    author_id = (select auth.uid())
    or private.turn_details_ok(service_id, requester_id)
    or exists (select 1 from public.service_requests r where r.id = request_id and r.teacher_id = (select auth.uid()))
  )
);

-- Not even the database owner's functions change them: a message, once written, stays as it was.
create or replace function private.turn_message_locked()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.request_id is null and old.request_id is not null
     and (new.id, new.body, new.author_id, new.kind, new.created_at) = (old.id, old.body, old.author_id, old.kind, old.created_at) then
    return new; -- the turn was deleted (on delete set null): the message stays
  end if;
  raise exception 'Los mensajes de un turno no se pueden cambiar ni borrar.';
end;
$$;
drop trigger if exists service_request_messages_locked on public.service_request_messages;
create trigger service_request_messages_locked before update or delete on public.service_request_messages
for each row execute function private.turn_message_locked();

/**
 * Writes in a turn's chat. kind: 'message'; 'call', the note when the service calls the student (to the teacher and the
 * group's teachers, who got the call); 'cancel', why it was cancelled. The other side hears it.
 */
create or replace function public.send_turn_message(p_id bigint, p_body text, p_kind text default 'message')
returns public.service_request_messages
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  r public.service_requests;
  s public.school_services;
  v_body text := private.clean_text(p_body, 1000, 'El mensaje');
  v_serves boolean;
  v_side boolean;
  v_to uuid[];
  v_group uuid[] := '{}';
  v_who text;
  v_link text := '#/turns/' || p_id;
  m public.service_request_messages;
begin
  if v_body is null then raise exception 'Escribe el mensaje.'; end if;
  if p_kind is null or p_kind not in ('message', 'call', 'cancel') then raise exception 'Mensaje no válido.'; end if;
  select * into r from public.service_requests x where x.id = p_id and x.school_id = me.school_id;
  if r.id is null then raise exception 'No se encontró el turno.'; end if;
  select * into s from public.school_services x where x.id = r.service_id;
  v_serves := private.roles_of(me) && s.roles;
  v_side := r.created_by = me.id or r.teacher_id = me.id;
  if not (v_serves or v_side) then raise exception 'Solo quien atiende el turno y quien lo pidió pueden escribir aquí.'; end if;
  if p_kind = 'call' and not v_serves then raise exception 'Solo % deja una nota al llamar.', s.name; end if;
  if p_kind = 'call' and r.status not in ('called', 'sent') then raise exception 'Este turno no está llamado.'; end if;
  if p_kind = 'cancel' and r.status <> 'cancelled' then raise exception 'Este turno no está cancelado.'; end if;

  insert into public.service_request_messages
    (request_id, school_id, service_id, requester_id, student_name, turn_day, author_id, author_name, author_side, kind, body)
  values (r.id, r.school_id, r.service_id, r.created_by, r.student_name, (r.created_at at time zone 'America/Puerto_Rico')::date,
    me.id, me.full_name, case when v_serves then 'service' else 'teacher' end, p_kind, v_body)
  returning * into m;

  v_who := case when s.mode = 'support'
    then coalesce((select d.reason from public.service_request_details d where d.request_id = r.id), 'el pedido')
    else format('%s (%s)', r.student_name, r.group_name) end;
  if v_serves then
    v_to := private.uuid_minus(array_remove(array[r.teacher_id, r.created_by], null), array[me.id]);
    if p_kind = 'call' and s.mode <> 'support' then
      v_group := private.group_teacher_ids(r.school_id, r.group_name, array[me.id, r.teacher_id]);
    end if;
  else
    -- Whoever has it; if nobody yet, everyone who attends the service.
    v_to := case when r.handled_by is not null and r.handled_by <> me.id then array[r.handled_by]
      else private.service_staff_ids(s.id, me.id) end;
  end if;

  -- A call or a cancellation with its note replaces the notice just sent, so nobody gets it twice.
  if p_kind in ('call', 'cancel') then perform private.close_notifications(v_link); end if;
  if p_kind = 'call' then
    perform private.notify_tagged(array_cat(v_to, v_group),
      format('📋 Envía a %s a %s', v_who, s.name),
      format('%s pide: «%s». Toca «Ya salió» cuando lo envíes.', me.full_name, left(v_body, 200)),
      v_link, 'turn-' || p_id, false);
  elsif p_kind = 'cancel' then
    perform private.notify_tagged(v_to,
      format('%s cancelado: %s', case when s.mode = 'support' then 'Pedido' else 'Turno' end, v_who),
      format('%s · lo canceló %s: «%s»', s.name, me.full_name, left(v_body, 200)),
      v_link, 'turn-' || p_id, false);
  else
    perform private.notify_tagged(v_to,
      format('💬 %s · %s', s.name, v_who),
      format('%s: %s', me.full_name, left(v_body, 200)),
      v_link, 'turn-msg-' || p_id, false);
  end if;
  return m;
end;
$$;
revoke execute on function public.send_turn_message(bigint, text, text) from public, anon;
grant execute on function public.send_turn_message(bigint, text, text) to authenticated;
