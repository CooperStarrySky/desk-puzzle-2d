-- Desk Puzzle: the puzzle group's workspace (docs/09-workspace-plan.md in the
-- platform repo). Step B1: the database only.
--
-- What this sets up, in plain English:
--   * admins        + display_name and color, for avatars and "by Priya N.".
--                   Each admin may change only their own.
--   * submissions   + tags (block/system labels the group adds) and a search
--                   index over the name, explanation, clue labels and clue notes.
--   * review_events the history of every suggestion: sent in, shortlisted,
--                   declined, reopened, used, commented on, voted for, put in or
--                   taken out of a draft, published. Written only by the
--                   database itself, so nobody can skip "who did it".
--   * comments      notes on a suggestion or a draft. Everyone in the group reads
--                   them; you can edit or delete only your own.
--   * votes         one thumbs-up per person per suggestion.
--   * drafts        puzzles being planned: Planning -> Ready -> Scheduled ->
--                   Published. Only the publishing robot (secret key) can mark
--                   one Published.
--   * draft_slots   the 4 tier slots of a draft.
--   * draft_events  the history of each draft (made, scheduled, lost a category
--                   to another puzzle, published...).
--   * activity      a read-only list that merges both histories for the team feed.
--   * publish_jobs  "Publish now" requests for the GitHub publishing job (later step).
--
-- Students and the public key see none of it. After applying, run
-- tools/leak_test.mjs: every line must say PASS.

create schema if not exists private;

-- ── Small helpers ───────────────────────────────────────────────────────────
-- The signed-in person's email, lower case (null for the robot / dashboard).
create or replace function private.my_email()
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(lower(trim(coalesce(auth.jwt() ->> 'email', ''))), '');
$$;

-- True while the publishing step is doing its own bookkeeping, so the
-- automatic history writers don't log the same change twice. Only database
-- functions can set it; the website API has no way to.
create or replace function private.quiet()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(current_setting('desk.quiet', true), '') = 'on';
$$;

-- True when a signed-in website user (not the robot or the dashboard) is
-- making the change. Must be called from a function that runs with the
-- caller's rights, otherwise current_user is the function's owner.
create or replace function private.from_website()
returns boolean
language sql
stable
set search_path = ''
as $$
  select current_user in ('authenticated', 'anon');
$$;

revoke all on function private.my_email(), private.quiet(), private.from_website() from public;
grant usage on schema private to authenticated, service_role;
grant execute on function private.my_email(), private.quiet(), private.from_website() to authenticated, service_role;

-- ── Admins: a name and a color for each person ──────────────────────────────
alter table public.admins
  add column display_name text check (display_name is null or char_length(display_name) between 1 and 40),
  add column color text check (color is null or color ~ '^#[0-9A-Fa-f]{6}$');

grant update (display_name, color) on table public.admins to authenticated;

create policy "Admins can set their own name and color"
  on public.admins for update to authenticated
  using ((select private.is_admin()) and lower(email) = (select private.my_email()))
  with check (lower(email) = (select private.my_email()));

-- ── Submissions: tags and search ────────────────────────────────────────────
-- Tags are short labels such as "Cardio" or "Renal" (at most 20 per suggestion).
alter table public.submissions
  add column tags text[] not null default '{}'
    check (cardinality(tags) <= 20 and char_length(array_to_string(tags, ',')) <= 600);

grant update (tags) on table public.submissions to authenticated;

-- Builds the search words for one suggestion. Works for both shapes of payload:
--   a category: { name, explanation, article[], items[{ label, note, info{text} }] }
--   a puzzle:   { title, groups[{ name, explanation, article[], items[...] }] }
-- Names count most (A), clue labels next (B), explanations and notes after (C).
-- It only looks at its two inputs, so Postgres may store the result in a column.
create or replace function private.submission_search(p_name text, p_payload jsonb)
returns tsvector
language sql
immutable
parallel safe
set search_path = ''
as $$
  with strings(weight, txt) as (
    select w.weight, v #>> '{}'
    from (values
      ('A', '$.name'), ('A', '$.title'), ('A', '$.groups[*].name'),
      ('B', '$.items[*].label'), ('B', '$.groups[*].items[*].label'),
      ('C', '$.explanation'), ('C', '$.groups[*].explanation'),
      ('C', '$.items[*].note'), ('C', '$.groups[*].items[*].note'),
      ('C', '$.items[*].info.text'), ('C', '$.groups[*].items[*].info.text'),
      ('C', '$.article[*].text'), ('C', '$.groups[*].article[*].text')
    ) as w(weight, path)
    cross join lateral pg_catalog.jsonb_path_query(coalesce(p_payload, '{}'::jsonb), w.path::jsonpath) as v
    where pg_catalog.jsonb_typeof(v) = 'string'
  )
  select
    pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::regconfig,
      coalesce(p_name, '') || ' ' || coalesce((select string_agg(txt, ' ') from strings where weight = 'A'), '')), 'A')
    || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::regconfig,
      coalesce((select string_agg(txt, ' ') from strings where weight = 'B'), '')), 'B')
    || pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.english'::regconfig,
      coalesce((select string_agg(txt, ' ') from strings where weight = 'C'), '')), 'C');
$$;

revoke all on function private.submission_search(text, jsonb) from public;
grant execute on function private.submission_search(text, jsonb) to authenticated, service_role;

alter table public.submissions
  add column search tsvector generated always as (private.submission_search(group_name, payload)) stored;

create index submissions_search on public.submissions using gin (search);
create index submissions_tags on public.submissions using gin (tags);

-- ── New tables ──────────────────────────────────────────────────────────────
-- History of each suggestion. actor_email is empty for the student who sent it
-- in. draft_id has no link rule on purpose: the history stays if a draft is deleted.
create table public.review_events (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions (id) on delete cascade,
  actor_email   text,
  action        text not null check (action in ('submitted', 'shortlist', 'decline', 'reopen', 'used',
                  'comment', 'vote', 'unvote', 'add_to_draft', 'remove_from_draft', 'publish')),
  note          text check (note is null or char_length(note) <= 2000),
  draft_id      uuid,
  at            timestamptz not null default now()
);
create index review_events_submission_at on public.review_events (submission_id, at desc);
create index review_events_at on public.review_events (at desc);
create index review_events_draft on public.review_events (draft_id) where draft_id is not null;

create table public.comments (
  id           uuid primary key default gen_random_uuid(),
  target_type  text not null check (target_type in ('submission', 'draft')),
  target_id    uuid not null,
  author_email text not null default private.my_email(),
  body         text not null check (char_length(btrim(body)) between 1 and 2000),
  at           timestamptz not null default now(),
  edited_at    timestamptz
);
create index comments_target on public.comments (target_type, target_id, at);
create index comments_at on public.comments (at desc);

create table public.votes (
  submission_id uuid not null references public.submissions (id) on delete cascade,
  voter_email   text not null default private.my_email(),
  at            timestamptz not null default now(),
  primary key (submission_id, voter_email)
);
create index votes_voter on public.votes (voter_email);

create table public.drafts (
  id                  uuid primary key default gen_random_uuid(),
  title               text not null check (char_length(btrim(title)) between 1 and 120),
  block               text check (block is null or char_length(block) <= 40),
  target_release      timestamptz,             -- the exact go-live moment (UI default: Thursday 6:00 AM ET)
  status              text not null default 'planning' check (status in ('planning', 'ready', 'scheduled', 'published')),
  owner_email         text not null default private.my_email(),
  notes               text check (notes is null or char_length(notes) <= 4000),
  dismissed_warnings  jsonb not null default '[]' check (jsonb_typeof(dismissed_warnings) = 'array'),
  published_puzzle_id text check (published_puzzle_id is null or (published_puzzle_id ~ '^[a-z0-9-]+-[0-9]{4}-[0-9]{2}-[0-9]{2}$' and length(published_puzzle_id) <= 120)),
  published_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  updated_by          text,
  constraint drafts_scheduled_needs_release check (status <> 'scheduled' or target_release is not null),
  constraint drafts_published_needs_puzzle check (status <> 'published' or published_puzzle_id is not null)
);
create index drafts_status_release on public.drafts (status, target_release);
create index drafts_owner on public.drafts (owner_email);

-- One row per filled slot (an empty slot has no row). A slot holds either a
-- suggestion (for a full-puzzle suggestion, group_index 0-3 picks one of its
-- groups) or a custom group the planners typed in themselves.
-- The tier key is checked at the end of a transaction when asked to, so two
-- slots can swap tiers in one step (public.swap_draft_slots).
create table public.draft_slots (
  draft_id      uuid not null references public.drafts (id) on delete cascade,
  tier          smallint not null check (tier between 1 and 4),
  submission_id uuid references public.submissions (id) on delete cascade,
  group_index   smallint check (group_index between 0 and 3),
  custom_group  jsonb check (custom_group is null or (jsonb_typeof(custom_group) = 'object' and octet_length(custom_group::text) <= 100000)),
  placed_by     text,
  placed_at     timestamptz not null default now(),
  constraint draft_slots_pkey primary key (draft_id, tier) deferrable initially immediate,
  constraint draft_slots_one_thing check (num_nonnulls(submission_id, custom_group) = 1),
  constraint draft_slots_group_needs_submission check (group_index is null or submission_id is not null)
);
create index draft_slots_submission on public.draft_slots (submission_id) where submission_id is not null;
-- The same suggestion (or the same group of a full puzzle) only once per draft.
create unique index draft_slots_once_per_draft
  on public.draft_slots (draft_id, submission_id, coalesce(group_index, -1)) where submission_id is not null;

-- History of each draft, for the Activity feed. notify_email names the person
-- who should hear about it (e.g. the owner of a draft that lost a category).
-- draft_id is not linked to drafts on purpose and the title is copied in, so
-- the lines survive when a draft is deleted ("Thirth P. deleted draft 'X'").
create table public.draft_events (
  id           uuid primary key default gen_random_uuid(),
  draft_id     uuid not null,
  draft_title  text not null,
  actor_email  text,
  action       text not null check (action in ('create', 'rename', 'status', 'schedule', 'unschedule', 'deleted',
                 'comment', 'lost_slot', 'reverted', 'publish_requested', 'publish')),
  note         text check (note is null or char_length(note) <= 2000),
  notify_email text,
  at           timestamptz not null default now()
);
create index draft_events_draft_at on public.draft_events (draft_id, at desc);
create index draft_events_at on public.draft_events (at desc);
create index draft_events_notify on public.draft_events (notify_email, at desc) where notify_email is not null;

-- "Publish now" requests and scheduled runs, for the GitHub publishing job.
-- Admins may only ask; the job (secret key) moves state along.
create table public.publish_jobs (
  id           uuid primary key default gen_random_uuid(),
  draft_id     uuid not null references public.drafts (id) on delete cascade,
  requested_by text default private.my_email(),
  requested_at timestamptz not null default now(),
  kind         text not null default 'now' check (kind in ('scheduled', 'now')),
  state        text not null default 'queued' check (state in ('queued', 'running', 'done', 'failed')),
  step         text check (step is null or char_length(step) <= 200),
  error        text check (error is null or char_length(error) <= 4000),
  finished_at  timestamptz
);
create index publish_jobs_draft on public.publish_jobs (draft_id, requested_at desc);
-- At most one waiting or running job per draft.
create unique index publish_jobs_one_open on public.publish_jobs (draft_id) where state in ('queued', 'running');

-- ── Backfill the history of suggestions already in the inbox ────────────────
-- One "sent in" event each, plus the last review we know of (who and when).
insert into public.review_events (submission_id, actor_email, action, note, at)
select s.id, null, 'submitted', null, s.created_at from public.submissions s;

insert into public.review_events (submission_id, actor_email, action, note, at)
select s.id, lower(s.reviewed_by),
       case s.status when 'shortlisted' then 'shortlist' when 'declined' then 'decline'
                     when 'used' then 'used' else 'reopen' end,
       s.admin_note, s.reviewed_at
from public.submissions s
where s.reviewed_by is not null and s.reviewed_at is not null;

-- ── Automatic history: suggestions ──────────────────────────────────────────
-- A new suggestion arrives (the submit function adds it).
create or replace function private.submission_added()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.review_events (submission_id, actor_email, action, note, at)
  values (new.id, null, 'submitted',
          case when new.credit_mode = 'named' then new.credit_name end, new.created_at);
  return null;
end;
$$;

create trigger submissions_log_added
  after insert on public.submissions
  for each row execute function private.submission_added();

-- Before a status change: stamp who did it and when, from the sign-in itself,
-- so the inbox can't attribute it to someone else.
create or replace function private.submission_stamp_review()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status and private.my_email() is not null then
    new.reviewed_by := private.my_email();
    new.reviewed_at := pg_catalog.now();
  end if;
  return new;
end;
$$;

create trigger submissions_stamp_review
  before update of status on public.submissions
  for each row execute function private.submission_stamp_review();

-- After a status change: write the history line (the reason is admin_note).
create or replace function private.submission_status_logged()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is distinct from old.status and not private.quiet() then
    insert into public.review_events (submission_id, actor_email, action, note)
    values (new.id, private.my_email(),
            case new.status when 'shortlisted' then 'shortlist' when 'declined' then 'decline'
                            when 'used' then 'used' else 'reopen' end,
            new.admin_note);
  end if;
  return null;
end;
$$;

create trigger submissions_log_status
  after update of status on public.submissions
  for each row execute function private.submission_status_logged();

-- ── Comments ────────────────────────────────────────────────────────────────
-- Author and time come from the sign-in; editing marks edited_at. A comment
-- must point at a suggestion or draft that exists.
create or replace function private.comment_before()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if private.from_website() then
      new.author_email := private.my_email();
      new.at := pg_catalog.now();
      new.edited_at := null;
    end if;
    if new.target_type = 'submission' and not exists (select 1 from public.submissions s where s.id = new.target_id) then
      raise exception 'That suggestion does not exist.' using errcode = '23503';
    elsif new.target_type = 'draft' and not exists (select 1 from public.drafts d where d.id = new.target_id) then
      raise exception 'That draft does not exist.' using errcode = '23503';
    end if;
  elsif new.body is distinct from old.body then
    new.edited_at := pg_catalog.now();
  end if;
  return new;
end;
$$;

create trigger comments_before
  before insert or update on public.comments
  for each row execute function private.comment_before();

create or replace function private.comment_logged()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.target_type = 'submission' then
    insert into public.review_events (submission_id, actor_email, action, note, at)
    values (new.target_id, new.author_email, 'comment', left(new.body, 280), new.at);
  else
    insert into public.draft_events (draft_id, draft_title, actor_email, action, note, at)
    select d.id, d.title, new.author_email, 'comment', left(new.body, 280), new.at
    from public.drafts d where d.id = new.target_id;
  end if;
  return null;
end;
$$;

create trigger comments_log
  after insert on public.comments
  for each row execute function private.comment_logged();

-- ── Votes ───────────────────────────────────────────────────────────────────
create or replace function private.vote_before()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if private.from_website() then
    new.voter_email := private.my_email();
    new.at := pg_catalog.now();
  end if;
  return new;
end;
$$;

create trigger votes_before
  before insert on public.votes
  for each row execute function private.vote_before();

create or replace function private.vote_logged()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.review_events (submission_id, actor_email, action) values (new.submission_id, new.voter_email, 'vote');
  elsif exists (select 1 from public.submissions s where s.id = old.submission_id) then
    -- (skipped when the vote disappears because the suggestion itself was deleted)
    insert into public.review_events (submission_id, actor_email, action) values (old.submission_id, old.voter_email, 'unvote');
  end if;
  return null;
end;
$$;

create trigger votes_log
  after insert or delete on public.votes
  for each row execute function private.vote_logged();

-- ── Drafts: the rules ───────────────────────────────────────────────────────
-- Runs with the caller's rights so it can tell a website user from the robot.
--   * Only the publishing job (secret key) may mark a draft Published.
--   * A published draft is frozen for website users (no edits, no delete).
--   * Ready and Scheduled need all 4 slots filled (Scheduled also needs a
--     release time; that one is a table check).
--   * The owner must be someone on the admins list.
create or replace function private.draft_before()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  web boolean := private.from_website();
begin
  if tg_op = 'DELETE' then
    if web and old.status = 'published' then
      raise exception 'A published draft stays as a record and cannot be deleted.' using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and web and old.status = 'published' then
    raise exception 'A published draft can no longer be changed.' using errcode = '42501';
  end if;
  new.owner_email := lower(btrim(new.owner_email));
  if web then
    if tg_op = 'INSERT' then
      new.created_at := pg_catalog.now();
    end if;
    if new.status = 'published' then
      raise exception 'Only the publishing job can mark a draft Published. Use Publish now.' using errcode = '42501';
    end if;
    if not exists (select 1 from public.admins a where lower(a.email) = new.owner_email) then
      raise exception 'The owner must be in the puzzle group.' using errcode = '23514';
    end if;
    if new.status in ('ready', 'scheduled') and (tg_op = 'INSERT' or new.status is distinct from old.status)
       and (select count(*) from public.draft_slots s where s.draft_id = new.id) < 4 then
      raise exception 'Fill all 4 slots before marking the draft %.', initcap(new.status) using errcode = '23514';
    end if;
  end if;
  if new.status = 'published' and (tg_op = 'INSERT' or old.status <> 'published') then
    new.published_at := coalesce(new.published_at, pg_catalog.now());
  end if;
  new.updated_at := pg_catalog.now();
  new.updated_by := private.my_email();
  return new;
end;
$$;

create trigger drafts_before
  before insert or update or delete on public.drafts
  for each row execute function private.draft_before();

create or replace function private.release_label(p timestamptz)
returns text
language sql
stable
set search_path = ''
as $$
  select pg_catalog.to_char(p at time zone 'America/New_York', 'Dy Mon FMDD, FMHH12:MI AM') || ' ET';
$$;

-- Draft history, and the hand-off to the publishing bookkeeping.
create or replace function private.draft_logged()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  who text := private.my_email();
begin
  if tg_op = 'INSERT' then
    insert into public.draft_events (draft_id, draft_title, actor_email, action) values (new.id, new.title, who, 'create');
    return null;
  elsif tg_op = 'DELETE' then
    insert into public.draft_events (draft_id, draft_title, actor_email, action) values (old.id, old.title, who, 'deleted');
    return null;
  end if;
  if not private.quiet() then
    if new.title is distinct from old.title then
      insert into public.draft_events (draft_id, draft_title, actor_email, action, note)
      values (new.id, new.title, who, 'rename', 'was ' || old.title);
    end if;
    if new.status = 'scheduled' and (old.status <> 'scheduled' or new.target_release is distinct from old.target_release) then
      insert into public.draft_events (draft_id, draft_title, actor_email, action, note)
      values (new.id, new.title, who, 'schedule', 'goes live ' || private.release_label(new.target_release));
    elsif old.status = 'scheduled' and new.status in ('planning', 'ready') then
      insert into public.draft_events (draft_id, draft_title, actor_email, action, note)
      values (new.id, new.title, who, 'unschedule', 'back to ' || initcap(new.status));
    elsif new.status is distinct from old.status and new.status <> 'published' then
      insert into public.draft_events (draft_id, draft_title, actor_email, action, note)
      values (new.id, new.title, who, 'status', initcap(old.status) || ' -> ' || initcap(new.status));
    end if;
  end if;
  if new.status = 'published' and old.status <> 'published' then
    perform private.on_draft_published(new.id);
  end if;
  return null;
end;
$$;

-- ── Draft slots ─────────────────────────────────────────────────────────────
-- Who placed it comes from the sign-in. A full-puzzle suggestion needs a
-- group_index (which of its 4 groups); a single category must not have one.
-- Slots of a published draft are frozen for website users.
create or replace function private.slot_before()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  web boolean := private.from_website();
  k text;
begin
  if web and exists (select 1 from public.drafts d
                     where d.id = (case when tg_op = 'DELETE' then old.draft_id else new.draft_id end)
                       and d.status = 'published') then
    raise exception 'A published draft can no longer be changed.' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if web then
    new.placed_by := private.my_email();
    new.placed_at := pg_catalog.now();
  end if;
  if new.submission_id is not null then
    select s.kind into k from public.submissions s where s.id = new.submission_id;
    if k = 'puzzle' and new.group_index is null then
      raise exception 'Pick which group of the full puzzle goes in this slot (group_index 0-3).' using errcode = '23514';
    elsif k = 'category' and new.group_index is not null then
      raise exception 'group_index is only for full-puzzle suggestions.' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger draft_slots_before
  before insert or update or delete on public.draft_slots
  for each row execute function private.slot_before();

create or replace function private.tier_name(t int)
returns text
language sql
immutable
set search_path = ''
as $$
  select (array['Easy', 'Medium', 'Hard', 'Hardest'])[t];
$$;

-- History lines on the suggestion: added to / moved in / removed from a draft.
create or replace function private.slot_logged()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  who text := private.my_email();
  title text;
begin
  if private.quiet() then
    return null;
  end if;
  select d.title into title from public.drafts d
  where d.id = (case when tg_op = 'DELETE' then old.draft_id else new.draft_id end);
  if tg_op in ('UPDATE', 'DELETE') and old.submission_id is not null
     and (tg_op = 'DELETE' or new.submission_id is distinct from old.submission_id)
     and exists (select 1 from public.submissions s where s.id = old.submission_id) then
    insert into public.review_events (submission_id, actor_email, action, note, draft_id)
    values (old.submission_id, who, 'remove_from_draft',
            case when title is null then 'removed when its draft was deleted' else 'removed from draft ' || title end,
            old.draft_id);
  end if;
  -- A Ready or Scheduled draft must always have all 4 slots. If one is
  -- emptied (by hand, or because its suggestion was deleted), the draft goes
  -- back to Planning; the drafts trigger logs that change.
  if tg_op = 'DELETE' then
    update public.drafts o set status = 'planning'
     where o.id = old.draft_id and o.status in ('ready', 'scheduled')
       and (select count(*) from public.draft_slots s where s.draft_id = o.id) < 4;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.submission_id is not null then
    if tg_op = 'INSERT' or new.submission_id is distinct from old.submission_id then
      insert into public.review_events (submission_id, actor_email, action, note, draft_id)
      values (new.submission_id, who, 'add_to_draft', 'added to draft ' || title || ' as ' || private.tier_name(new.tier), new.draft_id);
    elsif new.tier <> old.tier then
      insert into public.review_events (submission_id, actor_email, action, note, draft_id)
      values (new.submission_id, who, 'add_to_draft', 'moved to ' || private.tier_name(new.tier) || ' in ' || title, new.draft_id);
    end if;
  end if;
  return null;
end;
$$;

create trigger draft_slots_log
  after insert or update or delete on public.draft_slots
  for each row execute function private.slot_logged();

-- Swap two tiers of a draft in one step (drag one slot onto another).
-- Runs with the caller's rights, so the usual admin rules apply.
create or replace function public.swap_draft_slots(p_draft_id uuid, p_tier_a int, p_tier_b int)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_tier_a = p_tier_b or p_tier_a not between 1 and 4 or p_tier_b not between 1 and 4 then
    raise exception 'Pick two different tiers from 1 to 4.' using errcode = '22023';
  end if;
  set constraints public.draft_slots_pkey deferred;
  update public.draft_slots
     set tier = case when tier = p_tier_a then p_tier_b else p_tier_a end
   where draft_id = p_draft_id and tier in (p_tier_a, p_tier_b);
  set constraints public.draft_slots_pkey immediate;
end;
$$;

revoke all on function public.swap_draft_slots(uuid, int, int) from public, anon;
grant execute on function public.swap_draft_slots(uuid, int, int) to authenticated;

-- ── Publish jobs ────────────────────────────────────────────────────────────
-- A website user may only ask for "Publish now" on a Ready or Scheduled draft.
create or replace function private.job_before()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if private.from_website() then
    new.requested_by := private.my_email();
    new.requested_at := pg_catalog.now();
    new.state := 'queued';
    new.step := null;
    new.error := null;
    new.finished_at := null;
    if new.kind <> 'now' then
      raise exception 'Scheduled runs are started by the publishing job itself.' using errcode = '42501';
    end if;
    if not exists (select 1 from public.drafts d where d.id = new.draft_id and d.status in ('ready', 'scheduled')) then
      raise exception 'Only a Ready or Scheduled draft can be published.' using errcode = '23514';
    end if;
    if (select count(*) from public.draft_slots s where s.draft_id = new.draft_id) < 4 then
      raise exception 'Fill all 4 slots before publishing.' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger publish_jobs_before
  before insert on public.publish_jobs
  for each row execute function private.job_before();

create or replace function private.job_logged()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.draft_events (draft_id, draft_title, actor_email, action, note)
  select d.id, d.title, new.requested_by, 'publish_requested',
         case new.kind when 'now' then 'Publish now' else 'scheduled run' end
  from public.drafts d where d.id = new.draft_id;
  return null;
end;
$$;

create trigger publish_jobs_log
  after insert on public.publish_jobs
  for each row execute function private.job_logged();

-- ── What happens when a draft is published ──────────────────────────────────
-- The publishing job (secret key) sets the draft's status to 'published' and
-- its published_puzzle_id; the trigger below then runs this. It:
--   1. marks every suggestion in the draft Used (used_in = the puzzle id),
--   2. takes those suggestions out of every other unpublished draft,
--   3. puts any of those drafts that were Scheduled back to Ready, and any
--      that were Ready back to Planning, and
--   4. writes it all to the history, naming each affected draft's owner so
--      they get told.
-- It can also be called by hand with the secret key. Website users cannot.
create or replace function private.on_draft_published(p_draft_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.drafts%rowtype;
  who text;
  ids uuid[];
  hit uuid[];
begin
  select * into d from public.drafts where id = p_draft_id for update;
  if not found or d.status <> 'published' or d.published_puzzle_id is null then
    raise exception 'Draft % is not marked published with a puzzle id.', p_draft_id;
  end if;
  who := coalesce(private.my_email(),
    (select j.requested_by from public.publish_jobs j
      where j.draft_id = p_draft_id and j.state in ('queued', 'running')
      order by j.requested_at desc limit 1));

  perform pg_catalog.set_config('desk.quiet', 'on', true);

  select coalesce(array_agg(distinct s.submission_id), '{}') into ids
  from public.draft_slots s where s.draft_id = p_draft_id and s.submission_id is not null;

  -- 1. Used
  update public.submissions
     set status = 'used', used_in = d.published_puzzle_id,
         reviewed_by = coalesce(who, 'publishing job'), reviewed_at = pg_catalog.now()
   where id = any (ids);
  insert into public.review_events (submission_id, actor_email, action, note, draft_id)
  select x, who, 'publish', 'used in ' || d.title || ' (' || d.published_puzzle_id || ')', p_draft_id
  from unnest(ids) as x;

  -- 2. Out of the other drafts (remember which drafts were hit first)
  select coalesce(array_agg(distinct s.draft_id), '{}') into hit
  from public.draft_slots s join public.drafts o on o.id = s.draft_id
  where s.submission_id = any (ids) and o.id <> p_draft_id and o.status <> 'published';

  with gone as (
    delete from public.draft_slots s
     using public.drafts o
     where o.id = s.draft_id and s.submission_id = any (ids)
       and o.id <> p_draft_id and o.status <> 'published'
    returning s.draft_id, s.submission_id, o.title, o.owner_email
  ), ev as (
    insert into public.review_events (submission_id, actor_email, action, note, draft_id)
    select g.submission_id, who, 'remove_from_draft',
           'removed from draft ' || g.title || ' because it was published in ' || d.title, g.draft_id
    from gone g
  )
  insert into public.draft_events (draft_id, draft_title, actor_email, action, note, notify_email)
  select g.draft_id, g.title, who, 'lost_slot',
         'Removed ''' || sub.group_name || ''' because it was published in ''' || d.title || '''', g.owner_email
  from gone g join public.submissions sub on sub.id = g.submission_id;

  -- 3. Drafts that lost a category step back: Scheduled -> Ready (the
  --    owner's rule, so it keeps its place in the queue) and Ready -> Planning.
  --    Both tell the owner.
  with back as (
    update public.drafts o
       set status = case o.status when 'scheduled' then 'ready' else 'planning' end
     where o.id = any (hit) and o.status in ('scheduled', 'ready')
    returning o.id, o.title, o.owner_email, o.status
  )
  insert into public.draft_events (draft_id, draft_title, actor_email, action, note, notify_email)
  select b.id, b.title, who, 'reverted',
         'Back to ' || initcap(b.status) || ': a category was published in ''' || d.title || '''. Fill the slot'
           || case when b.status = 'ready' then ' and schedule again.' else '.' end, b.owner_email
  from back b;

  -- 4. The published draft itself
  insert into public.draft_events (draft_id, draft_title, actor_email, action, note)
  values (d.id, d.title, who, 'publish', 'published as ' || d.published_puzzle_id);

  perform pg_catalog.set_config('desk.quiet', 'off', true);
end;
$$;

revoke all on function private.on_draft_published(uuid) from public, anon, authenticated;
grant execute on function private.on_draft_published(uuid) to service_role;

create trigger drafts_log
  after insert or update or delete on public.drafts
  for each row execute function private.draft_logged();

-- Nobody calls the trigger helpers directly.
revoke all on function private.submission_added(), private.submission_stamp_review(), private.submission_status_logged(),
  private.comment_before(), private.comment_logged(), private.vote_before(), private.vote_logged(),
  private.draft_before(), private.draft_logged(), private.slot_before(), private.slot_logged(),
  private.job_before(), private.job_logged(), private.release_label(timestamptz), private.tier_name(int)
  from public;

-- ── Activity feed ───────────────────────────────────────────────────────────
-- One list for the team feed: everything that happened to suggestions and
-- drafts, newest first when read with "order by at desc". It reads with the
-- reader's own rights, so the admins-only rules below still apply.
create view public.activity
with (security_invoker = true)
as
  select e.at, e.actor_email, 'submission'::text as subject, e.action, e.note,
         e.submission_id, e.draft_id, s.group_name as subject_name, null::text as notify_email
  from public.review_events e
  join public.submissions s on s.id = e.submission_id
  union all
  select de.at, de.actor_email, 'draft'::text, de.action, de.note,
         null::uuid, de.draft_id, de.draft_title, de.notify_email
  from public.draft_events de;

-- ── Lock everything down ────────────────────────────────────────────────────
alter table public.review_events enable row level security;
alter table public.comments      enable row level security;
alter table public.votes         enable row level security;
alter table public.drafts        enable row level security;
alter table public.draft_slots   enable row level security;
alter table public.draft_events  enable row level security;
alter table public.publish_jobs  enable row level security;

-- Take away the default rights Supabase hands out, then give back only what
-- each table needs. The public key (anon) gets nothing at all.
revoke all on table public.review_events, public.comments, public.votes, public.drafts,
  public.draft_slots, public.draft_events, public.publish_jobs, public.activity from anon, authenticated;

grant select on table public.review_events, public.draft_events, public.activity to authenticated;
grant select, delete on table public.comments, public.votes, public.drafts, public.draft_slots to authenticated;
grant insert (target_type, target_id, body), update (body) on table public.comments to authenticated;
grant insert (submission_id) on table public.votes to authenticated;
grant insert (id, title, block, target_release, status, owner_email, notes, dismissed_warnings),
      update (title, block, target_release, status, owner_email, notes, dismissed_warnings)
  on table public.drafts to authenticated;
grant insert (draft_id, tier, submission_id, group_index, custom_group),
      update (tier, submission_id, group_index, custom_group)
  on table public.draft_slots to authenticated;
grant select, insert (draft_id, kind) on table public.publish_jobs to authenticated;

-- History: admins read; only the database writes.
create policy "Admins can read suggestion history" on public.review_events
  for select to authenticated using ((select private.is_admin()));
create policy "Admins can read draft history" on public.draft_events
  for select to authenticated using ((select private.is_admin()));

-- Comments: admins read all, write as themselves, edit/delete their own.
create policy "Admins can read comments" on public.comments
  for select to authenticated using ((select private.is_admin()));
create policy "Admins can comment as themselves" on public.comments
  for insert to authenticated
  with check ((select private.is_admin()) and author_email = (select private.my_email()));
create policy "Admins can edit their own comments" on public.comments
  for update to authenticated
  using ((select private.is_admin()) and author_email = (select private.my_email()))
  with check (author_email = (select private.my_email()));
create policy "Admins can delete their own comments" on public.comments
  for delete to authenticated
  using ((select private.is_admin()) and author_email = (select private.my_email()));

-- Votes: admins read all, add and take back only their own.
create policy "Admins can read votes" on public.votes
  for select to authenticated using ((select private.is_admin()));
create policy "Admins can vote as themselves" on public.votes
  for insert to authenticated
  with check ((select private.is_admin()) and voter_email = (select private.my_email()));
create policy "Admins can take back their own vote" on public.votes
  for delete to authenticated
  using ((select private.is_admin()) and voter_email = (select private.my_email()));

-- Drafts and slots: any admin may plan (the triggers above hold the rules).
create policy "Admins can read drafts" on public.drafts
  for select to authenticated using ((select private.is_admin()));
create policy "Admins can make drafts" on public.drafts
  for insert to authenticated with check ((select private.is_admin()));
create policy "Admins can edit drafts" on public.drafts
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy "Admins can delete drafts" on public.drafts
  for delete to authenticated using ((select private.is_admin()));

create policy "Admins can read slots" on public.draft_slots
  for select to authenticated using ((select private.is_admin()));
create policy "Admins can fill slots" on public.draft_slots
  for insert to authenticated with check ((select private.is_admin()));
create policy "Admins can change slots" on public.draft_slots
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy "Admins can empty slots" on public.draft_slots
  for delete to authenticated using ((select private.is_admin()));

-- Publish jobs: admins read and ask for "Publish now"; only the job updates them.
create policy "Admins can read publish jobs" on public.publish_jobs
  for select to authenticated using ((select private.is_admin()));
create policy "Admins can ask to publish now" on public.publish_jobs
  for insert to authenticated
  with check ((select private.is_admin()) and kind = 'now' and requested_by = (select private.my_email()));
