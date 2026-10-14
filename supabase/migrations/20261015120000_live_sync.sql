-- Live syncing + presence for the puzzle workspace (B6).
--
-- How it works: Realtime "Broadcast from the database" on PRIVATE channels,
-- not Postgres Changes. Postgres Changes skips row rules for deletes and checks
-- every change once per subscriber on one thread; Supabase recommends
-- Broadcast for both security and scale.
--
-- After a write, a statement-level trigger sends a small note ("drafts
-- updated: these ids, by this person") to one private topic:
--   ws:bank             the shared category database (submissions, votes,
--                       comments every school can see, shared history)
--   ws:school:<slug>    one school's private things (drafts, slots, draft
--                       history, school-only comments, school history, people
--                       changes) + who is online in that school (presence)
-- Notes carry ids, table, action and who did it. Never titles, comment text,
-- clues or anything else from the row: the page fetches the rows again
-- through the normal row rules, so a note can't leak content even if it ever
-- reached the wrong person.
--
-- Who may listen is decided by row rules on realtime.messages (Realtime
-- Authorization): the bank topic for any member; a school topic only for that
-- school's members and the site owner. Presence may only be published on your
-- own school's topic. Nobody may broadcast from the page; only these triggers
-- send. The public key gets nothing.
--
-- Safe failure: sending never blocks a write. If Realtime is missing or the
-- send fails, the change still saves and a warning goes to the log.
--
-- Release: in Realtime Settings turn OFF "Allow public access", so only
-- private (signed-in, rule-checked) channels exist.

-- ── Sending ────────────────────────────────────────────────────────────────
-- One note per topic per statement. items: up to 50 small objects (ids); for
-- bigger bulk changes items is null and the page reloads that area.
create or replace function private.rt_emit(p_topic text, p_table text, p_op text, p_items jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  n int := coalesce(jsonb_array_length(p_items), 0);
begin
  if p_topic is null or n = 0 then return; end if;
  begin
    if pg_catalog.to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then return; end if;
    execute 'select realtime.send($1, $2, $3, true)' using
      pg_catalog.jsonb_build_object('t', p_table, 'op', pg_catalog.lower(p_op), 'by', private.my_email(), 'n', n,
        'items', case when n <= 50 then p_items end),
      'change', p_topic;
  exception when others then
    raise warning 'live sync: note to % not sent: %', p_topic, sqlerrm;
  end;
end;
$$;

-- Topic for one school's private notes (null school = no note).
create or replace function private.rt_school_topic(p_school text)
returns text language sql immutable set search_path = '' as $$
  select case when p_school is null or p_school = '' then null else 'ws:school:' || p_school end;
$$;

-- Groups (topic, item) pairs and sends one note per topic.
create or replace function private.rt_send_all(p_table text, p_op text, p_pairs jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in
    select x ->> 'topic' as topic, pg_catalog.jsonb_agg(x -> 'item') as items
    from pg_catalog.jsonb_array_elements(coalesce(p_pairs, '[]')) x
    where x ->> 'topic' is not null
    group by x ->> 'topic'
  loop
    perform private.rt_emit(r.topic, p_table, p_op, r.items);
  end loop;
end;
$$;

-- ── One trigger function per table ─────────────────────────────────────────
-- Each is fired once per statement with the changed rows as "rt_rows" (new
-- rows for insert/update, old rows for delete) and, for updates, "rt_old".
create or replace function private.rt_submissions()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.rt_send_all('submissions', tg_op,
    (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('topic', 'ws:bank', 'item', pg_catalog.jsonb_build_object('id', x.id))) from rt_rows x));
  return null;
end;
$$;

create or replace function private.rt_votes()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.rt_send_all('votes', tg_op,
    (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('topic', 'ws:bank', 'item', pg_catalog.jsonb_build_object('sid', x.submission_id))) from rt_rows x));
  return null;
end;
$$;

-- Comments: a draft's comments go to the draft's school; a category comment
-- for "all schools" goes to the bank; a school-only one to that school.
-- An edit that changes who can see it notes both the old and the new place.
create or replace function private.rt_comment_topic(p_type text, p_target uuid, p_vis text, p_school text)
returns text language sql stable security definer set search_path = '' as $$
  select case when p_type = 'draft' then private.rt_school_topic(private.draft_school(p_target))
              when p_vis = 'all' then 'ws:bank'
              else private.rt_school_topic(p_school) end;
$$;

create or replace function private.rt_comments()
returns trigger language plpgsql security definer set search_path = '' as $$
declare p jsonb;
begin
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'topic', private.rt_comment_topic(x.target_type, x.target_id, x.visibility, x.school),
           'item', pg_catalog.jsonb_build_object('id', x.id, 'type', x.target_type, 'target', x.target_id)))
    into p from rt_rows x;
  if tg_op = 'UPDATE' then
    select coalesce(p, '[]') || coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'topic', private.rt_comment_topic(o.target_type, o.target_id, o.visibility, o.school),
             'item', pg_catalog.jsonb_build_object('id', o.id, 'type', o.target_type, 'target', o.target_id))), '[]')
      into p from rt_old o join rt_rows n on n.id = o.id
     where private.rt_comment_topic(o.target_type, o.target_id, o.visibility, o.school)
           is distinct from private.rt_comment_topic(n.target_type, n.target_id, n.visibility, n.school);
  end if;
  perform private.rt_send_all('comments', tg_op, p);
  return null;
end;
$$;

-- Category history: shared lines (no school) to the bank, school lines to the school.
create or replace function private.rt_review_events()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.rt_send_all('review_events', tg_op,
    (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
       'topic', case when x.school is null then 'ws:bank' else private.rt_school_topic(x.school) end,
       'item', pg_catalog.jsonb_build_object('id', x.id, 'sid', x.submission_id))) from rt_rows x));
  return null;
end;
$$;

create or replace function private.rt_drafts()
returns trigger language plpgsql security definer set search_path = '' as $$
declare p jsonb;
begin
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('topic', private.rt_school_topic(x.school),
           'item', pg_catalog.jsonb_build_object('id', x.id))) into p from rt_rows x;
  if tg_op = 'UPDATE' then -- a draft moved to another school: tell the old school too
    select coalesce(p, '[]') || coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('topic', private.rt_school_topic(o.school),
             'item', pg_catalog.jsonb_build_object('id', o.id))), '[]')
      into p from rt_old o join rt_rows n on n.id = o.id where o.school is distinct from n.school;
  end if;
  perform private.rt_send_all('drafts', tg_op, p);
  return null;
end;
$$;

-- Slots: to the draft's school. When a whole draft is deleted its slots go
-- with it; the draft's own note covers that.
create or replace function private.rt_draft_slots()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.rt_send_all('draft_slots', tg_op,
    (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('topic', private.rt_school_topic(private.draft_school(x.draft_id)),
       'item', pg_catalog.jsonb_build_object('d', x.draft_id, 't', x.tier))) from rt_rows x));
  return null;
end;
$$;

create or replace function private.rt_draft_events()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.rt_send_all('draft_events', tg_op,
    (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('topic', private.rt_school_topic(x.school),
       'item', pg_catalog.jsonb_build_object('id', x.id, 'd', x.draft_id))) from rt_rows x));
  return null;
end;
$$;

create or replace function private.rt_member_events()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.rt_send_all('member_events', tg_op,
    (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('topic', private.rt_school_topic(x.school),
       'item', pg_catalog.jsonb_build_object('id', x.id))) from rt_rows x));
  return null;
end;
$$;

create or replace function private.rt_publish_jobs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.rt_send_all('publish_jobs', tg_op,
    (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('topic', private.rt_school_topic(private.draft_school(x.draft_id)),
       'item', pg_catalog.jsonb_build_object('id', x.id, 'd', x.draft_id))) from rt_rows x));
  return null;
end;
$$;

revoke all on function private.rt_emit(text, text, text, jsonb), private.rt_school_topic(text), private.rt_send_all(text, text, jsonb),
  private.rt_comment_topic(text, uuid, text, text), private.rt_submissions(), private.rt_votes(), private.rt_comments(),
  private.rt_review_events(), private.rt_drafts(), private.rt_draft_slots(), private.rt_draft_events(),
  private.rt_member_events(), private.rt_publish_jobs() from public, anon, authenticated;

-- ── Triggers (once per statement; transition tables keep bulk changes cheap) ──
do $$
declare
  t text;
  tabs text[][] := array[
    array['submissions', 'iud'], array['votes', 'iud'], array['comments', 'iud'], array['review_events', 'i'],
    array['drafts', 'iud'], array['draft_slots', 'iud'], array['draft_events', 'i'], array['member_events', 'i'],
    array['publish_jobs', 'iu']];
  i int;
begin
  for i in 1 .. array_length(tabs, 1) loop
    t := tabs[i][1];
    execute format('drop trigger if exists rt_live_ins on public.%I', t);
    execute format('drop trigger if exists rt_live_upd on public.%I', t);
    execute format('drop trigger if exists rt_live_del on public.%I', t);
    if position('i' in tabs[i][2]) > 0 then
      execute format('create trigger rt_live_ins after insert on public.%I referencing new table as rt_rows
        for each statement execute function private.rt_%s()', t, t);
    end if;
    if position('u' in tabs[i][2]) > 0 then
      execute format('create trigger rt_live_upd after update on public.%I referencing new table as rt_rows old table as rt_old
        for each statement execute function private.rt_%s()', t, t);
    end if;
    if position('d' in tabs[i][2]) > 0 then
      execute format('create trigger rt_live_del after delete on public.%I referencing old table as rt_rows
        for each statement execute function private.rt_%s()', t, t);
    end if;
  end loop;
end;
$$;

-- ── Who may listen (Realtime Authorization) ────────────────────────────────
-- Realtime asks these rules when a page joins a private channel, with the
-- channel's topic in realtime.topic(). RLS is already on for realtime.messages
-- (Supabase manages that table; never "enable row level security" on it here).
create or replace function private.rt_school_ok(p_topic text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(p_topic like 'ws:school:%'
     and (private.is_site_owner() or pg_catalog.substr(p_topic, 11) = any (private.my_schools())), false);
$$;
revoke all on function private.rt_school_ok(text) from public, anon;
grant execute on function private.rt_school_ok(text) to authenticated, service_role;

drop policy if exists "Workspace members hear the shared category database" on realtime.messages;
drop policy if exists "School members hear their school" on realtime.messages;
drop policy if exists "School members share who is online" on realtime.messages;

create policy "Workspace members hear the shared category database" on realtime.messages
  for select to authenticated
  using (realtime.messages.extension = 'broadcast'
         and (select realtime.topic()) = 'ws:bank'
         and (select private.is_member()));
create policy "School members hear their school" on realtime.messages
  for select to authenticated
  using (realtime.messages.extension in ('broadcast', 'presence')
         and (select private.rt_school_ok((select realtime.topic()))));
-- Presence only (who is viewing what); no page may broadcast.
create policy "School members share who is online" on realtime.messages
  for insert to authenticated
  with check (realtime.messages.extension = 'presence'
              and (select private.rt_school_ok((select realtime.topic()))));
