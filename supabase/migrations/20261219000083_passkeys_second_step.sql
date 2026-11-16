-- Passkeys as the second step: the app uses Supabase's passkeys (Authentication › Passkeys, kept in
-- auth.webauthn_credentials) for the daily verification, besides the authenticator app. So:
--   * «Ya configuró la verificación» (Personal) counts a passkey too.
--   * Reiniciar la verificación (or turning it off with «borrar lo configurado») also removes the person's passkeys, so
--     a lost phone can't be used to pass it.

/** Whether this person already set up a way to pass the second step (the authenticator app or a passkey). */
create or replace function private.has_mfa(p_user uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from auth.mfa_factors f where f.user_id = p_user and f.status = 'verified')
    or exists (select 1 from auth.webauthn_credentials w where w.user_id = p_user)
$$;

-- Same as in 20261113000047, removing the passkeys too.
/** Removes the configured authenticator and passkeys of these people of my school. Returns how many had one. */
create or replace function public.reset_mfa(p_ids uuid[])
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_ids uuid[];
  v_count int;
begin
  if not private.can(me, 'staff') then raise exception 'No tienes permiso para cambiar esto.'; end if;
  select coalesce(array_agg(p.id), '{}') into v_ids from public.profiles p
  where p.id = any(coalesce(p_ids, '{}')) and p.school_id = me.school_id and p.role <> 'admin';
  if cardinality(v_ids) = 0 then raise exception 'Elige al menos una persona.'; end if;

  select count(distinct u) into v_count from (
    select f.user_id as u from auth.mfa_factors f where f.user_id = any(v_ids)
    union select w.user_id from auth.webauthn_credentials w where w.user_id = any(v_ids)
  ) x;
  delete from auth.mfa_factors where user_id = any(v_ids);
  delete from auth.webauthn_credentials where user_id = any(v_ids);
  perform private.notify(private.uuid_minus(v_ids, array[me.id]),
    '🔐 Vuelve a configurar tu verificación en dos pasos',
    format('%s reinició tu verificación en dos pasos. La próxima vez que Hallway te lo pida, te mostrará el QR para configurarlo de nuevo en tu app de autenticación.', me.full_name),
    '#/profile');
  return v_count;
end;
$$;

revoke execute on function public.reset_mfa(uuid[]) from public, anon;
grant execute on function public.reset_mfa(uuid[]) to authenticated;

-- Same as in 20261113000047, removing the passkeys too when what was set up is erased.
/**
 * Turns two-step verification on or off for these people of my school. p_reset (when turning it off): also removes their
 * configured authenticator and passkeys, so they set it up again from scratch. Returns how many changed.
 */
create or replace function public.set_require_mfa(p_ids uuid[], p_on boolean, p_reset boolean default false)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_ids uuid[];
begin
  if not private.can(me, 'staff') then raise exception 'No tienes permiso para cambiar esto.'; end if;
  if p_on is null then raise exception 'Elige activar o desactivar.'; end if;
  select coalesce(array_agg(p.id), '{}') into v_ids from public.profiles p
  where p.id = any(coalesce(p_ids, '{}')) and p.school_id = me.school_id and p.role <> 'admin';
  if cardinality(v_ids) = 0 then raise exception 'Elige al menos una persona.'; end if;

  update public.profiles set require_mfa = p_on where id = any(v_ids) and require_mfa is distinct from p_on;
  if not p_on and coalesce(p_reset, false) then
    delete from auth.mfa_factors where user_id = any(v_ids);
    delete from auth.webauthn_credentials where user_id = any(v_ids);
  end if;
  perform private.notify(private.uuid_minus(v_ids, array[me.id]),
    case when p_on then '🔐 Verificación en dos pasos activada' else '🔓 Verificación en dos pasos desactivada' end,
    case when p_on
      then format('%s te activó la verificación en dos pasos: una vez al día Hallway te pedirá el código de tu app de autenticación (Google o Microsoft Authenticator). La primera vez te ayuda a configurarla.', me.full_name)
      else format('%s te quitó la verificación en dos pasos: Hallway ya no te pedirá el código.', me.full_name) end,
    '#/profile');
  return cardinality(v_ids);
end;
$$;
