-- Código del día por persona: quien maneja el personal (permiso `staff`; la cuenta de Administración lo tiene todo)
-- se lo activa o desactiva a quien quiera, de uno en uno, por rol o marcando varias personas en Personal. Quien lo
-- tiene activado escribe una vez al día el código de su app de autenticación (Supabase MFA, TOTP), en cualquier
-- teléfono. Al desactivarlo se puede borrar también su app configurada (por si perdió el teléfono).
-- Con dos cuentas en un mismo teléfono se sigue pidiendo aunque nadie lo active (accounts.js).

alter table public.profiles add column require_mfa boolean not null default false;

/** Whether this person already set up the authenticator app. */
create or replace function private.has_mfa(p_user uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from auth.mfa_factors f where f.user_id = p_user and f.status = 'verified')
$$;

create or replace view public.employees_v with (security_invoker = true) as
select p.id, p.school_id, p.role, p.username, p.full_name, p.email, p.phone, p.employee_number, p."position",
  p.active, p.must_change_password, p.last_login_at, p.created_at, p.updated_at,
  (select count(*) from public.absences a where a.user_id = p.id and a.status <> 'cancelled')::integer as absence_count,
  p.password_help_at, p.room, p.groups,
  p.require_mfa,
  private.has_mfa(p.id) as mfa_ready
from public.profiles p
where p.role <> 'admin';

/** Does the open account have to give today's code? (the app asks once a day). */
create or replace function public.mfa_required()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select p.require_mfa from public.profiles p where p.id = auth.uid()), false)
$$;

/**
 * Turns the daily code on or off for these people of my school. p_reset (when turning it off): also removes their
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
    case when p_on then '🔐 Código del día activado' else '🔓 Código del día desactivado' end,
    case when p_on
      then format('%s te activó el código del día: una vez al día Hallway te pedirá el código de tu app de autenticación (Google o Microsoft Authenticator). La primera vez te ayuda a configurarla.', me.full_name)
      else format('%s te quitó el código del día: ya no te lo pedirá.', me.full_name) end,
    '#/profile');
  return cardinality(v_ids);
end;
$$;

-- employees_v (security invoker) calls it as whoever reads Personal; the private schema isn't on the API.
revoke execute on function private.has_mfa(uuid) from public, anon;
grant execute on function private.has_mfa(uuid) to authenticated;
revoke execute on function public.mfa_required(), public.set_require_mfa(uuid[], boolean, boolean) from public, anon;
grant execute on function public.mfa_required(), public.set_require_mfa(uuid[], boolean, boolean) to authenticated;
