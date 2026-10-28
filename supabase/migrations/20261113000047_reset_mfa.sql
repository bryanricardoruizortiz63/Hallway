-- Reiniciar el código del día: si a alguien le da problemas (cambió de teléfono, borró la app de autenticación), la
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
    '🔐 Vuelve a configurar tu código del día',
    format('%s reinició tu código. La próxima vez que Hallway te lo pida, te mostrará el QR para configurarlo de nuevo en tu app de autenticación.', me.full_name),
    '#/profile');
  return v_count;
end;
$$;

revoke execute on function public.reset_mfa(uuid[]) from public, anon;
grant execute on function public.reset_mfa(uuid[]) to authenticated;
