-- For the creator of Hallway (the platform panel):
--   * feedback: what people say about the app or a problem they report, from Más › Comentarios y problemas. The
--     creator answers in the panel; the person gets a notice and sees the answer. Kept one year.
--   * app_errors: every error the app or the server had, with who (person, school), when, where (screen or
--     function) and every detail. Deleted after 30 days.
--   * login_failures: every failed sign-in (wrong school code, username or password), with the IP and the device.
--     After 5 failures for the same account (or 10 from the same place) in 15 minutes, the creator gets an email
--     (function «report»). Deleted after 30 days.
-- Nobody reads these tables directly: the app writes through the functions below or the «report» function, and the
-- platform panel reads them with the service key.

create table if not exists public.feedback (
  id bigint generated always as identity primary key,
  school_id uuid references public.schools(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  user_name text not null,
  kind text not null check (kind in ('idea', 'problem', 'other')),
  message text not null check (char_length(message) between 3 and 3000),
  route text check (char_length(route) <= 200),
  device text check (char_length(device) <= 300),
  app_version text check (char_length(app_version) <= 40),
  status text not null default 'new' check (status in ('new', 'seen', 'done')),
  reply text check (char_length(reply) <= 2000),
  replied_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists feedback_new on public.feedback (created_at desc);
create index if not exists feedback_user on public.feedback (user_id, created_at desc);

create table if not exists public.app_errors (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  source text not null check (source in ('app', 'server', 'database')),
  kind text check (char_length(kind) <= 40),
  school_id uuid references public.schools(id) on delete set null,
  school_name text,
  user_id uuid references public.profiles(id) on delete set null,
  user_name text,
  route text check (char_length(route) <= 300),
  message text not null check (char_length(message) <= 1000),
  detail text check (char_length(detail) <= 8000),
  status integer,
  ip text,
  device text check (char_length(device) <= 300),
  app_version text check (char_length(app_version) <= 40)
);
create index if not exists app_errors_at on public.app_errors (at desc);

create table if not exists public.login_failures (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  school_code text check (char_length(school_code) <= 40),
  school_id uuid references public.schools(id) on delete set null,
  school_name text,
  username text check (char_length(username) <= 120),
  user_id uuid references public.profiles(id) on delete set null,
  user_name text,
  reason text not null check (reason in ('school', 'username', 'password', 'inactive', 'other')),
  ip text,
  device text check (char_length(device) <= 300),
  alerted boolean not null default false
);
create index if not exists login_failures_account on public.login_failures (school_code, username, at desc);
create index if not exists login_failures_ip on public.login_failures (ip, at desc);
create index if not exists login_failures_at on public.login_failures (at desc);

alter table public.feedback enable row level security;
alter table public.app_errors enable row level security;
alter table public.login_failures enable row level security;
revoke all on public.feedback, public.app_errors, public.login_failures from anon, authenticated;

-- ---- Comentarios y problemas (the app) --------------------------------------------------------------------------

/** Sends a comment or a problem to Hallway's creator. At most 10 an hour per person. */
create or replace function public.send_feedback(p_kind text, p_message text, p_route text default null,
  p_device text default null, p_app_version text default null)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_msg text := btrim(coalesce(p_message, ''));
  v_id bigint;
begin
  if p_kind not in ('idea', 'problem', 'other') then raise exception 'Elige si es una idea, un problema u otra cosa.'; end if;
  if char_length(v_msg) < 3 then raise exception 'Escribe qué quieres contarnos.'; end if;
  if char_length(v_msg) > 3000 then raise exception 'El mensaje es demasiado largo (máx. 3000 caracteres).'; end if;
  if (select count(*) from public.feedback f where f.user_id = me.id and f.created_at > now() - interval '1 hour') >= 10 then
    raise exception 'Ya enviaste varios mensajes en la última hora. Espera un poco.';
  end if;
  insert into public.feedback (school_id, user_id, user_name, kind, message, route, device, app_version)
  values (me.school_id, me.id, me.full_name, p_kind, v_msg, left(p_route, 200), left(p_device, 300), left(p_app_version, 40))
  returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function public.send_feedback(text, text, text, text, text) from public, anon;
grant execute on function public.send_feedback(text, text, text, text, text) to authenticated;

/** What I sent, with the answers. */
create or replace function public.my_feedback()
returns table (id bigint, kind text, message text, status text, reply text, replied_at timestamptz, created_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select f.id, f.kind, f.message, f.status, f.reply, f.replied_at, f.created_at
  from public.feedback f
  where f.user_id = auth.uid()
  order by f.created_at desc
  limit 50
$$;
revoke execute on function public.my_feedback() from public, anon;
grant execute on function public.my_feedback() to authenticated;

-- ---- Errors the app sees (signed in) ----------------------------------------------------------------------------

/** An error the app had, with who and where. At most 60 an hour per person (the same error repeated counts once). */
create or replace function public.log_app_error(p_kind text, p_message text, p_detail text default null,
  p_route text default null, p_status integer default null, p_device text default null, p_app_version text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles;
begin
  select * into me from public.profiles p where p.id = auth.uid();
  if not found then return; end if;
  if (select count(*) from public.app_errors e where e.user_id = me.id and e.at > now() - interval '1 hour') >= 60 then return; end if;
  -- The same error on the same screen within a minute: once.
  if exists (select 1 from public.app_errors e where e.user_id = me.id and e.at > now() - interval '1 minute'
             and e.message = left(coalesce(p_message, ''), 1000) and e.route is not distinct from left(p_route, 300)) then
    return;
  end if;
  insert into public.app_errors (source, kind, school_id, school_name, user_id, user_name, route, message, detail, status,
    device, app_version)
  values ('app', left(p_kind, 40), me.school_id, (select s.name from public.schools s where s.id = me.school_id), me.id,
    me.full_name, left(p_route, 300), left(coalesce(nullif(btrim(p_message), ''), 'Error sin mensaje'), 1000),
    left(p_detail, 8000), p_status, left(p_device, 300), left(p_app_version, 40));
end;
$$;
revoke execute on function public.log_app_error(text, text, text, text, integer, text, text) from public, anon;
grant execute on function public.log_app_error(text, text, text, text, integer, text, text) to authenticated;

-- ---- 30 days ----------------------------------------------------------------------------------------------------

create or replace function private.purge_platform_logs()
returns void
language sql security definer set search_path = ''
as $$
  delete from public.app_errors where at < now() - interval '30 days';
  delete from public.login_failures where at < now() - interval '30 days';
  delete from public.feedback where created_at < now() - interval '1 year';
$$;
revoke execute on function private.purge_platform_logs() from public, anon, authenticated;

select cron.unschedule('hallway-platform-logs') where exists (select 1 from cron.job where jobname = 'hallway-platform-logs');
select cron.schedule('hallway-platform-logs', '17 7 * * *', $job$select private.purge_platform_logs()$job$);
