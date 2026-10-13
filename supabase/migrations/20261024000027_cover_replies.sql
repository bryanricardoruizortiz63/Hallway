-- Cobertura: whoever covers answers whoever assigned it.
--   * «Recibido»: they got the notice. «Voy en camino»: on a day they cover, they're going to the classroom (it also
--     counts as received). Each answer reaches whoever assigned that coverage (Secretaría, the dirección…) at once.
--   * The answer is kept in each row of the list (received_at, on_the_way_at), so the absence, today's list and
--     «Vas a cubrir» show it. A row that changes (days, hours, groups, room) is a new assignment: it has to be
--     confirmed again.
--   * Rows now keep who assigned them (set_by). For the ones assigned before, the person is found by name, or else
--     everyone who confirms absences is told.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

/** A row without who assigned it, when, or the answers: what was assigned (to compare). */
create or replace function private.cover_core(c jsonb)
returns jsonb
language sql immutable set search_path = ''
as $$
  select c - 'set_by_name' - 'set_at' - 'set_by' - 'received_at' - 'on_the_way_at'
$$;

/** A person's rows in a list, without who assigned them, when or the answers (to compare). */
create or replace function private.cover_parts(p_covers jsonb, p_key text)
returns jsonb
language sql immutable set search_path = ''
as $$
  select coalesce(jsonb_agg(private.cover_core(e.value) order by e.ordinality), '[]'::jsonb)
  from jsonb_array_elements(p_covers) with ordinality e
  where private.cover_key(e.value) = p_key
$$;

/** Whether a row has its person covering that day (days: their days; empty = every day of the absence). */
create or replace function private.cover_on(a public.absences, c jsonb, p_day date)
returns boolean
language sql immutable set search_path = ''
as $$
  select case when jsonb_array_length(coalesce(c->'days', '[]'::jsonb)) = 0 then p_day between a.start_date and a.end_date
    else c->'days' ? to_char(p_day, 'YYYY-MM-DD') end
$$;

/** Who assigned a row: set_by, or (older rows) someone who confirms absences with that name. */
create or replace function private.cover_assigner(a public.absences, c jsonb)
returns uuid
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select p.id from public.profiles p
     where p.id = nullif(c->>'set_by', '')::uuid and p.school_id = a.school_id and p.active),
    (select p.id from public.profiles p
     where p.school_id = a.school_id and p.active and p.full_name = c->>'set_by_name' and private.can(p, 'absences')
     order by p.role = 'admin', p.id limit 1))
$$;

-- ---------------------------------------------------------------------------
-- Assigning: rows keep who assigned them
-- ---------------------------------------------------------------------------

/**
 * Who covers: the whole list, in order (up to 40 rows). Each row: substitute_id (someone of the staff, who gets a
 * notice) or name (someone from outside), days (dates of the absence; empty = every day), groups (of the
 * school's calendar), room, and start_time / end_time (optional; by default the absence's hours). A person can
 * be on more than one row for different days. Whoever is new is told; whoever's days, groups, room or hours
 * changed is told again; whoever is no longer on it is told too. The absent person isn't told: it shows in their
 * absence. An empty list removes the coverage. A row that stays the same keeps who assigned it and its answers.
 */
create or replace function public.set_absence_covers(p_id bigint, p_covers jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  a public.absences := private.load_absence(p_id, me);
  v_school text[];
  v_absent text;
  v_item jsonb;
  v_old jsonb;
  v_new jsonb := '[]'::jsonb;
  v_person public.profiles;
  v_sub text;
  v_groups text[];
  v_missing text;
  v_room text;
  v_start time;
  v_end time;
  v_days date[];
  v_key text;
  v_old_parts jsonb;
  v_new_parts jsonb;
begin
  if not private.can(me, 'absences') then
    raise exception 'No tienes permiso para realizar esta acción.';
  end if;
  if a.status = 'cancelled' then
    raise exception 'La ausencia está cancelada.';
  end if;
  if p_covers is null or jsonb_typeof(p_covers) <> 'array' then
    raise exception 'La lista de cobertura no es válida.';
  end if;
  if jsonb_array_length(p_covers) > 40 then
    raise exception 'La cobertura puede tener hasta 40 filas.';
  end if;
  select x.groups into v_school from public.school_settings x where x.school_id = a.school_id;
  select full_name into v_absent from public.profiles where id = a.user_id;

  for v_item in select e.value from jsonb_array_elements(p_covers) e loop
    if jsonb_typeof(v_item) <> 'object' or jsonb_typeof(coalesce(v_item->'days', '[]'::jsonb)) <> 'array' then
      raise exception 'La lista de cobertura no es válida.';
    end if;
    v_person := null;
    v_sub := private.clean_text(v_item->>'name', 300, 'El nombre de quien cubre');
    if nullif(v_item->>'substitute_id', '') is not null then
      select * into v_person from public.profiles p
      where p.id = (v_item->>'substitute_id')::uuid and p.school_id = a.school_id and p.active and p.role <> 'admin';
      if v_person.id is null then
        raise exception 'No se encontró a esa persona del personal.';
      end if;
      if v_person.id = a.user_id then
        raise exception 'Elige a otra persona: % es quien va a faltar.', v_person.full_name;
      end if;
      v_sub := v_person.full_name;
    elsif v_sub is null then
      raise exception 'Escribe el nombre de quien cubre.';
    end if;

    v_days := array(select distinct d::date from jsonb_array_elements_text(coalesce(v_item->'days', '[]'::jsonb)) d order by 1);
    if exists (select 1 from unnest(v_days) d where d < a.start_date or d > a.end_date) then
      raise exception 'Elige días de la ausencia para %.', v_sub;
    end if;

    v_groups := array(
      select distinct btrim(e.grp) from jsonb_array_elements_text(coalesce(v_item->'groups', '[]'::jsonb)) as e(grp)
      where btrim(e.grp) <> '');
    if cardinality(v_groups) > 20 then
      raise exception 'Elige hasta 20 grupos por persona.';
    end if;
    select e.grp into v_missing from unnest(v_groups) as e(grp) where not e.grp = any(coalesce(v_school, '{}')) limit 1;
    if v_missing is not null then
      raise exception 'El grupo % no está en el calendario escolar.', v_missing;
    end if;
    -- In the school's order.
    v_groups := array(
      select t.grp from unnest(v_school) with ordinality as t(grp, ord) where t.grp = any(v_groups) order by t.ord);

    v_room := private.clean_text(v_item->>'room', 40, 'El salón');
    v_start := nullif(v_item->>'start_time', '')::time;
    v_end := nullif(v_item->>'end_time', '')::time;
    if (v_start is null) <> (v_end is null) then
      raise exception 'Indica de qué hora a qué hora cubre %.', v_sub;
    end if;
    if v_end <= v_start then
      raise exception 'La hora final debe ser después de la inicial (%).', v_sub;
    end if;

    v_item := jsonb_build_object(
      'substitute_id', v_person.id, 'name', v_sub,
      'days', (select coalesce(jsonb_agg(to_char(d, 'YYYY-MM-DD') order by d), '[]'::jsonb) from unnest(v_days) d),
      'groups', to_jsonb(v_groups), 'room', v_room,
      'start_time', to_char(v_start, 'HH24:MI'), 'end_time', to_char(v_end, 'HH24:MI'));
    -- The same row as before (same person and days): who assigned it, when and the answers stay.
    select o.value into v_old from jsonb_array_elements(a.covers) o
    where private.cover_core(o.value) = v_item
    limit 1;
    v_item := coalesce(v_old, v_item || jsonb_build_object('set_by_name', me.full_name, 'set_at', now(), 'set_by', me.id));
    v_new := v_new || jsonb_build_array(v_item);
  end loop;

  -- A person twice on the same day (or on every day and again on one).
  select e1.value->>'name' into v_sub
  from jsonb_array_elements(v_new) with ordinality e1
  join jsonb_array_elements(v_new) with ordinality e2
    on e1.ordinality < e2.ordinality and private.cover_key(e1.value) = private.cover_key(e2.value)
  where jsonb_array_length(e1.value->'days') = 0 or jsonb_array_length(e2.value->'days') = 0
     or exists (select 1 from jsonb_array_elements_text(e1.value->'days') x
                join jsonb_array_elements_text(e2.value->'days') y on y = x)
  limit 1;
  if v_sub is not null then
    raise exception '% está dos veces el mismo día.', v_sub;
  end if;

  if v_new = a.covers then
    return;
  end if;

  update public.absences
  set covers = v_new,
      substitute = private.cover_names(v_new),
      substitute_id = (v_new->0->>'substitute_id')::uuid,
      cover_groups = array(select jsonb_array_elements_text(coalesce(v_new->0->'groups', '[]'::jsonb))),
      cover_room = v_new->0->>'room',
      cover_set_by_name = (select e.value->>'set_by_name' from jsonb_array_elements(v_new) e
                           order by (e.value->>'set_at')::timestamptz desc limit 1),
      cover_set_at = (select max((e.value->>'set_at')::timestamptz) from jsonb_array_elements(v_new) e),
      updated_at = now()
  where id = a.id;

  -- One notice per person of the staff whose part changed, with everything they cover.
  for v_key in
    select distinct private.cover_key(e.value)
    from jsonb_array_elements(a.covers || v_new) e
    where e.value->>'substitute_id' is not null
  loop
    v_old_parts := private.cover_parts(a.covers, v_key);
    v_new_parts := private.cover_parts(v_new, v_key);
    continue when v_old_parts = v_new_parts;
    if v_new_parts = '[]'::jsonb then
      perform private.notify_tagged(
        private.cover_user(v_old_parts->0), 'Ya no cubres a ' || v_absent,
        private.fmt_range(a.start_date, a.end_date) || ' · lo cambió ' || me.full_name,
        '#/cover/' || a.id, 'cover-' || a.id, false
      );
    else
      perform private.notify_tagged(
        private.cover_user(v_new_parts->0),
        case when v_old_parts = '[]'::jsonb then '📋 Vas a cubrir a ' else '📋 Cambió tu cobertura de ' end || v_absent,
        private.cover_notice_all(a, v_new_parts) || '. Toca «Recibido» para avisarle a ' || me.full_name || '.',
        '#/cover/' || a.id, 'cover-' || a.id, false
      );
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Answering
-- ---------------------------------------------------------------------------

/**
 * Whoever covers answers: received («Recibido») or on_the_way («Voy en camino», on p_day: the phone's date, a day
 * they cover). It reaches whoever assigned those rows. Saying it again doesn't tell them again.
 * Returns my rows' answers: [{ received_at, on_the_way_at }].
 */
create or replace function public.reply_coverage(p_id bigint, p_step text, p_day date default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  a public.absences;
  v_absent text;
  v_mine jsonb;
  v_new jsonb;
  v_to uuid[];
  v_body text;
begin
  select * into a from public.absences x where x.id = p_id and x.school_id = me.school_id for update;
  if a.id is null or not a.covers @> jsonb_build_array(jsonb_build_object('substitute_id', me.id)) then
    raise exception 'No se encontró tu cobertura.';
  end if;
  if a.status = 'cancelled' then raise exception 'Se canceló la ausencia: ya no tienes que cubrir.'; end if;
  if p_step is null or p_step not in ('received', 'on_the_way') then raise exception 'Paso no válido.'; end if;
  select full_name into v_absent from public.profiles where id = a.user_id;

  -- The rows it's about: all of mine (received), or the ones of that day (on the way).
  if p_step = 'on_the_way' then
    if p_day is null or p_day not between current_date - 1 and current_date + 1 then
      raise exception 'Avisa que vas en camino el día que cubres.';
    end if;
    select coalesce(jsonb_agg(e.value), '[]'::jsonb) into v_mine from jsonb_array_elements(a.covers) e
    where e.value->>'substitute_id' = me.id::text and private.cover_on(a, e.value, p_day);
    if v_mine = '[]'::jsonb then raise exception 'Ese día no te toca cubrir a %.', v_absent; end if;
    -- Already said in the last hours: nothing new to tell.
    if not exists (select 1 from jsonb_array_elements(v_mine) e
                   where coalesce((e.value->>'on_the_way_at')::timestamptz, '-infinity') < now() - interval '6 hours') then
      return private.cover_answers(a, me.id);
    end if;
  else
    select coalesce(jsonb_agg(e.value), '[]'::jsonb) into v_mine from jsonb_array_elements(a.covers) e
    where e.value->>'substitute_id' = me.id::text;
    if not exists (select 1 from jsonb_array_elements(v_mine) e where e.value->>'received_at' is null) then
      return private.cover_answers(a, me.id);
    end if;
  end if;

  v_new := (
    select jsonb_agg(case
        when e.value->>'substitute_id' = me.id::text and (p_step = 'received' or private.cover_on(a, e.value, p_day)) then
          e.value || jsonb_build_object('received_at', coalesce(e.value->'received_at', to_jsonb(now())))
            || case when p_step = 'on_the_way' then jsonb_build_object('on_the_way_at', now()) else '{}'::jsonb end
        else e.value end
      order by e.ordinality)
    from jsonb_array_elements(a.covers) with ordinality e);
  update public.absences set covers = v_new where id = a.id returning * into a;

  -- Whoever assigned those rows; if nobody can be found, whoever confirms absences.
  select coalesce(array_agg(distinct x), '{}') into v_to
  from (select private.cover_assigner(a, e.value) as x from jsonb_array_elements(v_mine) e) t where x is not null;
  if cardinality(v_to) = 0 then v_to := private.perm_ids(a.school_id, 'absences', me.id); end if;
  v_to := array_remove(v_to, me.id);

  v_body := (select string_agg(concat_ws(' · ',
      case when p_step = 'received' then private.cover_when(a, e.value) end,
      private.cover_schedule(a, e.value),
      private.cover_where(array(select jsonb_array_elements_text(coalesce(e.value->'groups', '[]'::jsonb))), e.value->>'room')),
    '; ') from jsonb_array_elements(v_mine) e);
  perform private.notify_tagged(v_to,
    case when p_step = 'received' then format('✅ %s recibió la cobertura de %s', me.full_name, v_absent)
      else format('🚶 %s va en camino a cubrir a %s', me.full_name, v_absent) end,
    coalesce(nullif(v_body, ''), private.fmt_range(a.start_date, a.end_date)) || '.',
    '#/absence/' || a.id, 'cover-reply-' || a.id || '-' || me.id, false);
  return private.cover_answers(a, me.id);
end;
$$;

/** My rows' answers in an absence, in order. */
create or replace function private.cover_answers(a public.absences, p_user uuid)
returns jsonb
language sql stable set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('received_at', e.value->'received_at', 'on_the_way_at', e.value->'on_the_way_at')
    order by e.ordinality), '[]'::jsonb)
  from jsonb_array_elements(a.covers) with ordinality e
  where e.value->>'substitute_id' = p_user::text
$$;

-- ---------------------------------------------------------------------------
-- What each substitute sees (Vas a cubrir): now with their answers
-- ---------------------------------------------------------------------------

-- The new one returns the answers too: the old one goes out of the API.
alter function public.my_coverages(date, bigint) set schema private;
alter function private.my_coverages(date, bigint) rename to my_coverages_before_replies;
revoke execute on function private.my_coverages_before_replies(date, bigint) from public, anon, authenticated;

/**
 * My coverages, one row per row of the list (a person can have more than one in an absence): from a date on (not
 * cancelled, with a day still to come), or every one of an absence by its id (also cancelled, to say so). Who,
 * when (cover_days: my days, null = every day of the absence), my groups, room and hours, the instructions, who
 * else covers it and my answers (received_at, on_the_way_at); never the type or the reason of the absence.
 */
create or replace function public.my_coverages(p_from date default null, p_id bigint default null)
returns table (
  id bigint, employee_name text, employee_position text, employee_role text, start_date date, end_date date,
  partial boolean, start_time time, end_time time, status text, coverage_notes text, cover_groups text[],
  cover_room text, cover_set_by_name text, cover_set_at timestamptz, cover_start_time time, cover_end_time time,
  others jsonb, cover_days date[], received_at timestamptz, on_the_way_at timestamptz
)
language sql stable security definer set search_path = ''
as $$
  select a.id, p.full_name, p.position, p.role, a.start_date, a.end_date, a.partial, a.start_time, a.end_time,
    a.status, a.coverage_notes,
    array(select jsonb_array_elements_text(coalesce(c.value->'groups', '[]'::jsonb))),
    c.value->>'room', c.value->>'set_by_name', (c.value->>'set_at')::timestamptz,
    (c.value->>'start_time')::time, (c.value->>'end_time')::time,
    (select coalesce(jsonb_agg(jsonb_build_object(
        'name', o.value->'name', 'groups', o.value->'groups', 'start_time', o.value->'start_time',
        'end_time', o.value->'end_time', 'days', coalesce(o.value->'days', '[]'::jsonb)) order by o.ordinality), '[]'::jsonb)
      from jsonb_array_elements(a.covers) with ordinality o
      where o.value->>'substitute_id' is distinct from (select auth.uid())::text),
    nullif(array(select d::date from jsonb_array_elements_text(coalesce(c.value->'days', '[]'::jsonb)) d order by 1), '{}'),
    (c.value->>'received_at')::timestamptz, (c.value->>'on_the_way_at')::timestamptz
  from public.absences a
  join public.profiles p on p.id = a.user_id
  cross join lateral jsonb_array_elements(a.covers) with ordinality c
  where a.covers @> jsonb_build_array(jsonb_build_object('substitute_id', (select auth.uid())))
    and c.value->>'substitute_id' = (select auth.uid())::text
    and a.school_id = (select private.my_school_id())
    and (case when p_id is not null then a.id = p_id
              else a.status <> 'cancelled' and a.end_date >= coalesce(p_from, current_date)
                and (jsonb_array_length(coalesce(c.value->'days', '[]'::jsonb)) = 0
                     or exists (select 1 from jsonb_array_elements_text(c.value->'days') d
                                where d::date >= coalesce(p_from, current_date))) end)
  order by coalesce((select min(d::date) from jsonb_array_elements_text(coalesce(c.value->'days', '[]'::jsonb)) d), a.start_date),
    coalesce((c.value->>'start_time')::time, a.start_time) nulls first, a.id, c.ordinality
  limit 200
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function
  private.cover_core(jsonb), private.cover_on(public.absences, jsonb, date),
  private.cover_assigner(public.absences, jsonb), private.cover_answers(public.absences, uuid)
  from public, anon, authenticated;
revoke execute on function public.reply_coverage(bigint, text, date), public.my_coverages(date, bigint) from public, anon;
grant execute on function public.reply_coverage(bigint, text, date), public.my_coverages(date, bigint) to authenticated;
