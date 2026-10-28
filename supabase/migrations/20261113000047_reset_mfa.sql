-- La verificación en dos pasos (antes «código del día») y reiniciarla: si a alguien le da problemas (cambió de teléfono, borró la app de autenticación), la
-- dirección (permiso `staff`) le borra la app configurada y la próxima vez que Hallway le pida el código le muestra
-- el QR para configurarla desde el principio. No cambia si tiene el código activado o no.

/** Removes the configured authenticator of these people of my school. Returns how many had one. */
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

  select count(distinct f.user_id) into v_count from auth.mfa_factors f where f.user_id = any(v_ids);
  delete from auth.mfa_factors where user_id = any(v_ids);
  perform private.notify(private.uuid_minus(v_ids, array[me.id]),
    '🔐 Vuelve a configurar tu verificación en dos pasos',
    format('%s reinició tu verificación en dos pasos. La próxima vez que Hallway te lo pida, te mostrará el QR para configurarlo de nuevo en tu app de autenticación.', me.full_name),
    '#/profile');
  return v_count;
end;
$$;

revoke execute on function public.reset_mfa(uuid[]) from public, anon;
grant execute on function public.reset_mfa(uuid[]) to authenticated;

-- Same as in 20261111000045, with the new name in the notices.
/**
 * Turns two-step verification on or off for these people of my school. p_reset (when turning it off): also removes their
 * configured authenticator, so they set it up again from scratch. Returns how many changed.
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
