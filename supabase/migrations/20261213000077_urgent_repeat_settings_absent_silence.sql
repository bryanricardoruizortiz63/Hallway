-- 1. Each school chooses, in the app (Escuela y Teams › Avisos urgentes), how its urgent notices repeat until someone
--    opens them: per kind (turns, «No ha llegado», pickups, relief, visits, maintenance), every 1, 2, 3, 5 or 10
--    minutes, or only once; and for how long (5 to 60 minutes). Until now it was fixed: every minute for 15 minutes
--    (relief: every 5). Those stay as the defaults.
-- 2. Whoever is absent right now gets no notices except the ones about their own absence (and their account): the
--    others still appear in the bell, as read, without sound or push. On by default; each person can turn it off in
--    Mi perfil › Notificaciones («absent_silence» in notify_off means they turned it off).

alter table public.school_settings add column if not exists urgent_repeat jsonb not null default '{}'::jsonb;

/** How a kind of urgent notice repeats in a school: every (minutes, 0 = only once) and for (minutes). */
create or replace function private.urgent_repeat_of(p_school uuid, p_kind text)
returns table (every_min integer, for_min integer)
language sql stable security definer set search_path = ''
as $$
  select
    coalesce((st.urgent_repeat -> p_kind ->> 'every')::int, case when p_kind = 'relief' then 5 else 1 end),
    coalesce((st.urgent_repeat -> p_kind ->> 'for')::int, 15)
  from (select 1) x
  left join public.school_settings st on st.school_id = p_school
$$;

-- Same as in 20261211000075, with each school's choice per kind.
create or replace function private.repeat_urgent()
returns void
language sql security definer set search_path = ''
as $$
  insert into public.outbox (kind, payload)
  select 'push', jsonb_build_object('notification_id', n.id, 'repeat', true)
  from public.notifications n
  join public.profiles p on p.id = n.user_id
  cross join lateral private.urgent_repeat_of(p.school_id, private.notice_kind(coalesce(n.link, ''))) r
  where n.urgent and n.read_at is null
    and r.every_min > 0
    and n.created_at < now() - interval '50 seconds'
    and n.created_at > now() - make_interval(mins => r.for_min) - interval '50 seconds'
    and (extract(epoch from now() - n.created_at)::int / 60) % r.every_min = 0
    -- A relief that someone took (or that was cancelled) stops ringing.
    and not exists (
      select 1 from public.relief_requests rr
      where n.link = '#/alerts/relief/' || rr.id and (rr.taken_at is not null or rr.cancelled_at is not null))
$$;

/** «Escuela y Teams › Avisos urgentes»: { kind: { every, for } } for the kinds that ring. */
create or replace function public.set_urgent_repeat(p_settings jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v jsonb := '{}'::jsonb;
  k text;
  e int;
  f int;
begin
  if not private.can(me, 'settings') then raise exception 'No tienes permiso para cambiar la configuración de la escuela.'; end if;
  for k in select jsonb_object_keys(coalesce(p_settings, '{}'::jsonb)) loop
    if k not in ('turns', 'alerts', 'pickups', 'relief', 'visits', 'maintenance') then
      raise exception 'Tipo de aviso no válido.';
    end if;
    e := (p_settings -> k ->> 'every')::int;
    f := (p_settings -> k ->> 'for')::int;
    if e is null or e not in (0, 1, 2, 3, 5, 10, 15) then raise exception 'Cada cuánto se repite no es válido.'; end if;
    if f is null or f not in (5, 10, 15, 20, 30, 45, 60) then raise exception 'Por cuánto tiempo no es válido.'; end if;
    v := v || jsonb_build_object(k, jsonb_build_object('every', e, 'for', f));
  end loop;
  update public.school_settings set urgent_repeat = v where school_id = me.school_id;
  return v;
end;
$$;
revoke execute on function public.set_urgent_repeat(jsonb) from public, anon;
grant execute on function public.set_urgent_repeat(jsonb) to authenticated;

-- ---- Absent: only what is about one's own absence -----------------------------------------------------------

/** The person has an absence that covers this moment (in the school's time zone). */
create or replace function private.absent_now(p_user uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    join public.absences a on a.user_id = p.id and a.status <> 'cancelled'
    cross join lateral (select now() at time zone coalesce(
      (select st.time_zone from public.school_settings st where st.school_id = p.school_id), 'America/Puerto_Rico') as t) l
    where p.id = p_user
      and l.t::date between a.start_date and a.end_date
      and (not a.partial or (l.t::time >= coalesce(a.start_time, '00:00') and (a.end_time is null or l.t::time < a.end_time)))
  )
$$;

/**
 * Before a notice is saved: if its person is absent now (and didn't turn the silence off), and it isn't about their
 * own absence or their account, it is kept read, without sound and without push.
 */
create or replace function private.absent_silence()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_link text := coalesce(new.link, '');
begin
  if new.read_at is not null then return new; end if;
  -- Their own absence (received, comments, changes), and their account.
  if v_link ~ '^#/absence/\d+' and exists (
    select 1 from public.absences a where a.id = substring(v_link from '^#/absence/(\d+)')::bigint and a.user_id = new.user_id
  ) then
    return new;
  end if;
  if v_link in ('', '#/notifications', '#/profile', '#/change-password') then return new; end if;
  if exists (select 1 from public.profiles p where p.id = new.user_id and 'absent_silence' = any(p.notify_off)) then
    return new;
  end if;
  if private.absent_now(new.user_id) then
    new.read_at := now();
    new.urgent := false;
  end if;
  return new;
end;
$$;
drop trigger if exists notifications_absent_silence on public.notifications;
create trigger notifications_absent_silence before insert on public.notifications
  for each row execute function private.absent_silence();

-- Same as in 20261128000062: a notice saved as read (silenced) isn't pushed.
create or replace function private.queue_push()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.read_at is not null then return new; end if;
  if exists (
    select 1 from public.profiles p
    where p.id = new.user_id and private.notice_kind(coalesce(new.link, '')) = any(p.notify_off)
  ) then
    return new;
  end if;
  insert into public.outbox (kind, payload) values ('push', jsonb_build_object('notification_id', new.id));
  return new;
end;
$$;

-- Same as in 20261128000062, accepting «absent_silence» (the silence while absent turned off).
create or replace function public.set_my_notify_off(p_kinds text[])
returns text[]
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v text[];
begin
  select coalesce(array_agg(distinct k order by k), '{}') into v
  from unnest(coalesce(p_kinds, '{}')) k
  where k in ('absences', 'turns', 'alerts', 'pickups', 'relief', 'visits', 'maintenance', 'rooms', 'messages', 'summary',
    'absent_silence');
  update public.profiles set notify_off = v where id = me.id;
  return v;
end;
$$;
