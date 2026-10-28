-- Dos cuentas en un teléfono (Más › Agregar otra cuenta): los avisos push de las dos llegan a ese teléfono, no solo
-- los de la cuenta abierta. Un mismo teléfono (endpoint) puede quedar ligado a varias personas.
-- p_keep: las otras cuentas guardadas en ese teléfono. Quien lo usó antes y ya no está guardado deja de recibir avisos
-- ahí (antes eso pasaba al reasignar el endpoint a la persona nueva).

alter table public.push_subscriptions drop constraint push_subscriptions_endpoint_key;
alter table public.push_subscriptions add constraint push_subscriptions_endpoint_user_key unique (endpoint, user_id);

drop function public.save_push_subscription(text, text, text);

create function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_keep uuid[] default '{}')
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.my_profile();
begin
  if me.id is null then
    raise exception 'Tu sesión expiró. Vuelve a iniciar sesión.' using hint = 'unauthorized';
  end if;
  if p_endpoint is null or p_endpoint not like 'https://%' or char_length(p_endpoint) > 1000
     or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    raise exception 'Suscripción no válida.';
  end if;
  delete from public.push_subscriptions
  where endpoint = p_endpoint and user_id <> me.id and not (user_id = any(coalesce(p_keep, '{}')));
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
  values (me.id, p_endpoint, left(p_p256dh, 200), left(p_auth, 100))
  on conflict (endpoint, user_id) do update set p256dh = excluded.p256dh, auth = excluded.auth;
end;
$$;

revoke execute on function public.save_push_subscription(text, text, text, uuid[]) from public, anon;
grant execute on function public.save_push_subscription(text, text, text, uuid[]) to authenticated;
