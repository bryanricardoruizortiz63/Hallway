-- Límites contra gastos: lo que se puede llamar sin iniciar sesión (código de escuela, logo, "olvidé mi contraseña"
-- y las Edge Functions) acepta como máximo 60 llamadas por minuto desde la misma IP, y la contraseña de plataforma
-- 10. La función "notify" solo la llama la base de datos: ahora con una clave que nadie más conoce.
-- Las tres funciones públicas son las mismas de antes (20261006000007 y 20260929000004) con el límite al inicio;
-- dejan de ser STABLE porque anotan la llamada.

create table private.rate_hits (
  key text primary key,
  window_start timestamptz not null default now(),
  hits int not null default 0
);
alter table private.rate_hits enable row level security;

/** The caller's IP as the API gateway sees it (the first address of x-forwarded-for). */
create or replace function private.client_ip()
returns text
language sql stable set search_path = ''
as $$
  select coalesce(nullif(btrim(split_part(
    coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for', ''), ',', 1)), ''), 'unknown')
$$;

/** Counts one call for p_key; false once there were more than p_max in the current window. */
create or replace function private.rate_limit(p_key text, p_max int, p_window interval default interval '1 minute')
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_hits int;
begin
  insert into private.rate_hits as h (key, window_start, hits) values (p_key, now(), 1)
  on conflict (key) do update set
    window_start = case when h.window_start <= now() - p_window then now() else h.window_start end,
    hits = case when h.window_start <= now() - p_window then 1 else h.hits + 1 end
  returning hits into v_hits;
  -- Now and then, forget the IPs that haven't called in a day.
  if random() < 0.01 then
    delete from private.rate_hits where window_start < now() - interval '1 day';
  end if;
  return v_hits <= p_max;
end;
$$;

create or replace function private.limit_ip(p_what text, p_max int default 60)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.rate_limit(p_what || ':' || private.client_ip(), p_max) then
    raise exception 'Demasiados intentos. Espera un minuto e inténtalo de nuevo.';
  end if;
end;
$$;

/** For the Edge Functions (service role): they pass the caller's IP themselves. */
create or replace function public.edge_rate_limit(p_key text, p_max int)
returns boolean
language sql security definer set search_path = ''
as $$
  select private.rate_limit(p_key, p_max)
$$;
revoke execute on function public.edge_rate_limit(text, int) from public, anon, authenticated;
grant execute on function public.edge_rate_limit(text, int) to service_role;

create or replace function public.current_school_code(p_code text)
returns text
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.limit_ip('school_code');
  return (
    select s.code
    from public.school_code_history h
    join public.schools s on s.id = h.school_id
    where h.code = upper(btrim(p_code)) and s.active
      and not exists (select 1 from public.schools x where x.code = upper(btrim(p_code)))
  );
end;
$$;

create or replace function public.school_branding(p_code text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.limit_ip('branding');
  return (
    select case when s.id is null then null else jsonb_build_object('school_id', s.id, 'icon_version', s.icon_version) end
    from private.resolve_school(p_code) s
  );
end;
$$;

create or replace function public.request_password_help(p_school_code text, p_username text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  s public.schools;
  p public.profiles;
begin
  perform private.limit_ip('password_help');
  s := private.resolve_school(p_school_code);
  if s.id is null then
    return;
  end if;
  select * into p from public.profiles
  where school_id = s.id and username = lower(btrim(p_username)) and active and role <> 'admin';
  if p.id is null or (p.password_help_at is not null and p.password_help_at > now() - interval '15 minutes') then
    return;
  end if;

  update public.profiles set password_help_at = now() where id = p.id;
  perform private.notify(
    private.manager_ids(s.id, p.id),
    'Olvidó su contraseña: ' || p.full_name,
    'Usuario: ' || p.username || '. Toca para darle una contraseña temporal.',
    '#/employees/' || p.id
  );
  insert into public.outbox (kind, school_id, payload)
  values ('teams', s.id, jsonb_build_object('event', 'password_help', 'user_id', p.id));
end;
$$;

-- "notify": the database sends a secret header; the function rejects calls without it.
insert into public.app_settings (key, value)
values ('notify_secret', jsonb_build_object('value', encode(extensions.gen_random_bytes(32), 'hex')))
on conflict (key) do nothing;

create or replace function private.dispatch_outbox()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  select value ->> 'url' into v_url from public.app_settings where key = 'notify_url';
  select value ->> 'value' into v_secret from public.app_settings where key = 'notify_secret';
  if v_url is not null then
    perform net.http_post(
      url := v_url,
      body := jsonb_build_object('id', new.id),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-notify-secret', coalesce(v_secret, '')),
      timeout_milliseconds := 15000
    );
  end if;
  return new;
end;
$$;
