-- El panel de plataforma (el que crea y maneja las escuelas), lo más seguro posible:
--   * Entrar pide la contraseña de plataforma y, cada vez, el código de una app de autenticación (TOTP). La primera
--     vez se configura escaneando un QR; quedan 10 códigos de recuperación de un solo uso por si se pierde el teléfono.
--   * La contraseña ya no viaja en cada acción: al entrar se abre una sesión que vence a los 20 minutos sin uso y a
--     las 8 horas siempre. La app la guarda solo en memoria: al recargar, hay que entrar de nuevo.
--   * Registro de actividad (entradas, intentos fallidos, cambios) y bloqueo de 15 minutos tras 10 intentos fallidos.
-- Todo esto lo lee y escribe solo la función platform (service_role); nadie más puede.
--
-- Si se pierden el teléfono y los códigos de recuperación, el dueño lo desactiva en el SQL Editor de Supabase:
--   update public.platform_security set totp_enabled = false, totp_secret = null, recovery_hashes = '{}';
-- y la próxima entrada vuelve a mostrar el QR.

create table public.platform_security (
  id boolean primary key default true check (id),
  totp_secret text,
  totp_enabled boolean not null default false,
  totp_last_counter bigint,
  pending_secret text,
  recovery_hashes text[] not null default '{}',
  updated_at timestamptz not null default now()
);
insert into public.platform_security (id) values (true) on conflict do nothing;

create table public.platform_sessions (
  token_hash text primary key,
  kind text not null check (kind in ('pending', 'full')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ip text,
  user_agent text
);

create table public.platform_audit (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  action text not null,
  ok boolean not null,
  ip text,
  user_agent text,
  detail text
);
create index platform_audit_at on public.platform_audit (at desc);

alter table public.platform_security enable row level security;
alter table public.platform_sessions enable row level security;
alter table public.platform_audit enable row level security;
revoke all on public.platform_security, public.platform_sessions, public.platform_audit from anon, authenticated;

/** A new platform password (the function checks the current one and the code first). */
create or replace function public.platform_set_password(p_password text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_password is null or char_length(p_password) < 12 then
    raise exception 'La contraseña de plataforma debe tener al menos 12 caracteres.';
  end if;
  insert into public.app_settings (key, value)
  values ('platform_password', jsonb_build_object('hash', extensions.crypt(p_password, extensions.gen_salt('bf', 12))))
  on conflict (key) do update set value = excluded.value;
end;
$$;

revoke execute on function public.platform_set_password(text) from public, anon, authenticated;
grant execute on function public.platform_set_password(text) to service_role;
