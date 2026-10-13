-- Cobertura: whoever covers is reminded every 2 minutes until they answer.
--   * «Recibido»: while a row assigned to them has no answer, their notice comes again every 2 minutes during the
--     school's hours (from an hour before classes start until they end, on school days), until they tap «Recibido»
--     (or «Voy en camino»).
--   * «Voy en camino»: on a day they cover, from 10 minutes before their hours start until those hours end, a notice
--     «Hoy cubres a …» comes every 2 minutes until they tap «Voy en camino».
--   * The same notice is pushed again (and shows as unread again): the bell doesn't fill with copies.
--   * Only rows assigned since there are answers (set_by): nobody is asked about older coverage.
--   * The school's hours are in its time zone (school_settings.time_zone; Puerto Rico by default).

alter table public.school_settings add column time_zone text not null default 'America/Puerto_Rico';

/** The reminders sent: one chain per absence, person and step (and day, for «Voy en camino»). */
create table public.cover_reminders (
  absence_id bigint not null references public.absences on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  step text not null check (step in ('received', 'on_the_way')),
  day date not null,
  notification_id bigint references public.notifications on delete set null,
  sent int not null default 0,
  last_at timestamptz not null default now(),
  primary key (absence_id, user_id, step, day)
);
-- Only the server uses it.
alter table public.cover_reminders enable row level security;
revoke all on public.cover_reminders from anon, authenticated;

/** Pushes a notice again (it shows as unread again) and notes the reminder. */
create or replace function private.cover_push_again(p_absence bigint, p_user uuid, p_step text, p_day date, p_notice bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.notifications set read_at = null where id = p_notice;
  insert into public.outbox (kind, payload) values ('push', jsonb_build_object('notification_id', p_notice, 'repeat', true));
  insert into public.cover_reminders (absence_id, user_id, step, day, notification_id, sent, last_at)
  values (p_absence, p_user, p_step, p_day, p_notice, 1, now())
  on conflict (absence_id, user_id, step, day)
  do update set notification_id = excluded.notification_id, sent = public.cover_reminders.sent + 1, last_at = now();
end;
$$;

/**
 * Every minute (pg_cron): reminds whoever covers until they answer. «Voy en camino» on the day they cover, within
 * their hours; otherwise «Recibido», within the school's hours. Every 2 minutes, never twice in a row for nothing.
 */
create or replace function private.remind_covers()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  k record;
  a public.absences;
  st record;
  v_local timestamp;
  v_today date;
  v_time time;
  v_rows jsonb;
  v_today_rows jsonb;
  v_first jsonb;
  v_from time;
  v_to time;
  v_absent text;
  v_notice bigint;
  v_notice_at timestamptz;
  rm public.cover_reminders;
begin
  for k in
    select x.id, (e.value->>'substitute_id')::uuid as sub
    from public.absences x
    cross join lateral jsonb_array_elements(x.covers) e
    join public.profiles p on p.id = (e.value->>'substitute_id')::uuid and p.active
    where x.status <> 'cancelled' and x.end_date >= current_date - 1
      and e.value->>'substitute_id' is not null and e.value ? 'set_by'
    group by 1, 2
  loop
    select * into a from public.absences x where x.id = k.id;
    select coalesce(s.time_zone, 'America/Puerto_Rico') as tz, coalesce(s.day_start, '07:40'::time) as day_start,
      coalesce(s.day_end, '15:30'::time) as day_end, coalesce(s.school_days, '{1,2,3,4,5}'::smallint[]) as school_days
    into st
    from (select 1) one left join public.school_settings s on s.school_id = a.school_id;
    v_local := now() at time zone st.tz;
    v_today := v_local::date;
    v_time := v_local::time;
    continue when v_today > a.end_date or not extract(isodow from v_today)::smallint = any(st.school_days);

    select jsonb_agg(e.value order by e.ordinality) into v_rows
    from jsonb_array_elements(a.covers) with ordinality e
    where e.value->>'substitute_id' = k.sub::text and e.value ? 'set_by';

    -- The day they cover: «Voy en camino», from 10 minutes before their hours until they end.
    select jsonb_agg(e.value order by coalesce((e.value->>'start_time')::time, case when a.partial then a.start_time end, st.day_start))
    into v_today_rows
    from jsonb_array_elements(v_rows) e
    where private.cover_on(a, e.value, v_today);
    if v_today_rows is not null then
      v_first := v_today_rows->0;
      v_from := coalesce((v_first->>'start_time')::time, case when a.partial then a.start_time end, st.day_start);
      select max(coalesce((e.value->>'end_time')::time, case when a.partial then a.end_time end, st.day_end)) into v_to
      from jsonb_array_elements(v_today_rows) e;
      if v_time >= v_from - interval '10 minutes' and v_time < v_to
         and not exists (select 1 from jsonb_array_elements(v_today_rows) e
                         where ((e.value->>'on_the_way_at')::timestamptz at time zone st.tz)::date = v_today) then
        select * into rm from public.cover_reminders r
        where r.absence_id = a.id and r.user_id = k.sub and r.step = 'on_the_way' and r.day = v_today;
        if rm.notification_id is null then
          -- Not right on top of the notice they just got.
          if not exists (select 1 from public.notifications n
                         where n.user_id = k.sub and n.link = '#/cover/' || a.id and n.created_at > now() - interval '110 seconds') then
            select full_name into v_absent from public.profiles where id = a.user_id;
            insert into public.notifications (user_id, title, body, link, tag, urgent)
            values (k.sub, '🚶 Hoy cubres a ' || v_absent,
              concat_ws(' · ', private.cover_schedule(a, v_first),
                private.cover_where(array(select jsonb_array_elements_text(coalesce(v_first->'groups', '[]'::jsonb))), v_first->>'room'))
                || '. Toca «Voy en camino» cuando salgas hacia el salón.',
              '#/cover/' || a.id, 'cover-' || a.id, false)
            returning id into v_notice;
            insert into public.cover_reminders (absence_id, user_id, step, day, notification_id, sent, last_at)
            values (a.id, k.sub, 'on_the_way', v_today, v_notice, 1, now())
            on conflict (absence_id, user_id, step, day)
            do update set notification_id = excluded.notification_id, sent = public.cover_reminders.sent + 1, last_at = now();
          end if;
        elsif rm.last_at <= now() - interval '110 seconds' then
          perform private.cover_push_again(a.id, k.sub, 'on_the_way', v_today, rm.notification_id);
        end if;
        continue;
      end if;
    end if;

    -- «Recibido»: their latest notice of this coverage, again, within the school's hours, while they have a day to
    -- come without an answer.
    continue when v_time < st.day_start - interval '1 hour' or v_time >= st.day_end
      or not exists (select 1 from jsonb_array_elements(v_rows) e
                     where e.value->>'received_at' is null
                       and (jsonb_array_length(coalesce(e.value->'days', '[]'::jsonb)) = 0
                            or exists (select 1 from jsonb_array_elements_text(e.value->'days') d where d::date >= v_today)));
    select n.id, n.created_at into v_notice, v_notice_at
    from public.notifications n
    where n.user_id = k.sub and n.link = '#/cover/' || a.id
      and not exists (select 1 from public.cover_reminders r where r.notification_id = n.id and r.step = 'on_the_way')
    order by n.id desc limit 1;
    select * into rm from public.cover_reminders r
    where r.absence_id = a.id and r.user_id = k.sub and r.step = 'received' and r.day = a.start_date;
    if v_notice is null then
      -- Their notice is gone: a new one.
      select full_name into v_absent from public.profiles where id = a.user_id;
      insert into public.notifications (user_id, title, body, link, tag, urgent)
      values (k.sub, '📋 Vas a cubrir a ' || v_absent,
        private.cover_notice_all(a, v_rows) || '. Toca «Recibido» para avisar que te llegó.',
        '#/cover/' || a.id, 'cover-' || a.id, false)
      returning id into v_notice;
      insert into public.cover_reminders (absence_id, user_id, step, day, notification_id, sent, last_at)
      values (a.id, k.sub, 'received', a.start_date, v_notice, 1, now())
      on conflict (absence_id, user_id, step, day)
      do update set notification_id = excluded.notification_id, sent = public.cover_reminders.sent + 1, last_at = now();
    elsif v_notice_at <= now() - interval '110 seconds'
      and (rm.last_at is null or rm.last_at <= now() - interval '110 seconds') then
      perform private.cover_push_again(a.id, k.sub, 'received', a.start_date, v_notice);
    end if;
  end loop;
end;
$$;

revoke execute on function private.cover_push_again(bigint, uuid, text, date, bigint), private.remind_covers()
  from public, anon, authenticated;

select cron.schedule('hallway-cover-reminders', '* * * * *', $job$select private.remind_covers()$job$);
