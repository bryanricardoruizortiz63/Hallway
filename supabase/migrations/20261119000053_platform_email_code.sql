-- Panel de plataforma: un solo código de recuperación (más largo; al usarlo se genera uno nuevo) y, en lugar del código
-- de la app, un código que llega por correo al dueño de la plataforma (vale 10 minutos y una sola vez). El correo lo
-- envía Resend (secreto RESEND_API_KEY de las Edge Functions) desde notificaciones@hallwayedu.com.

alter table public.platform_security
  add column email text,
  add column email_code_hash text,
  add column email_code_expires_at timestamptz,
  add column email_code_sent_at timestamptz;
