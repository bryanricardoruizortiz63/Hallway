-- «Pide relevo» rang too much: like every urgent notice, it was pushed again every minute for 15 minutes until
-- opened (and, with the app open, each one rang for a minute). Now a relief request rings when it is asked and then
-- every 5 minutes (at 5, 10 and 15), and stops as soon as someone takes it or it is cancelled. The other urgent
-- notices stay as they were (every minute, 15 minutes).

create or replace function private.repeat_urgent()
returns void
language sql security definer set search_path = ''
as $$
  insert into public.outbox (kind, payload)
  select 'push', jsonb_build_object('notification_id', n.id, 'repeat', true)
  from public.notifications n
  where n.urgent and n.read_at is null
    and n.created_at < now() - interval '50 seconds'
    and case
      when n.link like '#/alerts/relief/%' then
        n.created_at > now() - interval '16 minutes'
        -- Minute 5, 10 and 15 (the job runs every minute).
        and (extract(epoch from now() - n.created_at)::int / 60) in (5, 10, 15)
        and not exists (
          select 1 from public.relief_requests r
          where n.link = '#/alerts/relief/' || r.id and (r.taken_at is not null or r.cancelled_at is not null))
      else n.created_at > now() - interval '15 minutes'
    end
$$;
