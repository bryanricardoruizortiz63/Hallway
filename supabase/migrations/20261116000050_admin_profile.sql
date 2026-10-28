-- La cuenta de Administración es de una persona (la directora, el secretario…), no solo un rol: en Mi perfil escribe
-- su nombre, su puesto, su correo y su teléfono como cualquier usuario. Su nombre es el que ven los demás en los
-- mensajes, las ausencias que registra y los avisos. Al resto, su nombre y su puesto los pone quien maneja el personal.

/** The Administración account's own name, position, email and phone. */
create or replace function public.update_admin_profile(p_full_name text, p_position text, p_email text, p_phone text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_name text := private.clean_text(p_full_name, 120, 'El nombre');
begin
  if me.role <> 'admin' then raise exception 'Tu nombre y tu puesto los cambia quien maneja el personal.'; end if;
  if v_name is null then raise exception 'Escribe tu nombre.'; end if;
  update public.profiles
  set full_name = v_name,
      position = private.clean_text(p_position, 120, 'El puesto'),
      email = private.clean_text(p_email, 200, 'El correo'),
      phone = private.clean_text(p_phone, 40, 'El teléfono'),
      updated_at = now()
  where id = me.id;
end;
$$;

revoke execute on function public.update_admin_profile(text, text, text, text) from public, anon;
grant execute on function public.update_admin_profile(text, text, text, text) to authenticated;
