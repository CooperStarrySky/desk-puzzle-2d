-- Desk Puzzle: many schools, one shared category database (stage S1, database only).
--
-- What this sets up, in plain English:
--   * schools        each medical school's puzzle group (CMSRU only for now).
--   * site_owners    the person (or people) who run the whole site. Nobody is
--                    added here by this file; see supabase/SETUP.md.
--   * members        who may use the workspace, per school, with a role:
--                    lead (manages their school's people), admin, or faculty
--                    (reads, comments and approves drafts; never deletes).
--                    Everyone who was on the old admins list becomes a CMSRU admin.
--   * submissions    become the shared "category database": every member of
--                    every school can read them. Status is now new / used /
--                    trashed. Shortlisted ones go back to New; declined ones
--                    move to the Trash (who and why are kept).
--   * submission_edits  the history of fixes to an original category, each one undoable.
--   * draft_slots    may hold an adapted copy of a category ("Adapted from...").
--   * drafts         are private to their school (the site owner sees all).
--                    Faculty can approve a draft; it never blocks anything.
--   * comments       on a suggestion can be "my school only" or "all schools";
--                    comments on a draft always stay inside its school.
--   * votes          remember which school the voter voted for.
--   * category_uses  one row each time a category goes out in a published puzzle.
--   * school_settings / site_settings  small settings (faculty seal, comment
--                    default, how long the Trash keeps things).
--
-- Safe on the live database: nothing is deleted. The old admins table is kept
-- under a new name (admins_pre_multischool) as a backup, and a read-and-rename
-- compatible "admins" view takes its place so today's inbox keeps working
-- until the new screens ship. After applying, run tools/leak_test.mjs.

create schema if not exists private;

-- ── Schools ─────────────────────────────────────────────────────────────────
create table public.schools (
  slug       text primary key check (slug ~ '^[a-z0-9-]{2,24}$'),
  name       text not null check (char_length(btrim(name)) between 2 and 120),
  status     text not null default 'setup' check (status in ('active', 'setup')),
  created_at timestamptz not null default now()
);

insert into public.schools (slug, name, status)
values ('cmsru', 'Cooper Medical School of Rowan University', 'active')
on conflict (slug) do nothing;

-- Every school code already in use must be a real school from now on.
alter table public.submissions
  add constraint submissions_school_fk foreign key (school) references public.schools (slug);
alter table public.drafts
  add constraint drafts_school_fk foreign key (school) references public.schools (slug);

-- ── People ──────────────────────────────────────────────────────────────────
create table public.site_owners (
  email    text primary key check (email = lower(btrim(email)) and email like '%@%'),
  added_at timestamptz not null default now()
);

-- One row per person per school. The same email may be in several schools.
-- active = false is "access removed" (the row stays, so it can be restored).
create table public.members (
  email        text not null check (email = lower(btrim(email)) and email like '%@%'),
  school       text not null references public.schools (slug),
  role         text not null check (role in ('lead', 'admin', 'faculty')),
  display_name text check (display_name is null or char_length(display_name) between 1 and 40),
  color        text check (color is null or color ~ '^#[0-9A-Fa-f]{6}$'),
  active       boolean not null default true,
  added_by     text,
  added_at     timestamptz not null default now(),
  constraint members_pkey primary key (school, email)
);
create index members_email on public.members (email);

-- Who added, removed, or changed whom (shown in the Activity feed).
create table public.member_events (
  id           uuid primary key default gen_random_uuid(),
  school       text not null,
  actor_email  text,
  target_email text not null,
  action       text not null check (action in ('member_add', 'member_role', 'member_move', 'member_remove', 'member_restore')),
  note         text check (note is null or char_length(note) <= 500),
  at           timestamptz not null default now()
);
create index member_events_school_at on public.member_events (school, at desc);

-- Everyone on the old admins list becomes a CMSRU admin, keeping name and color.
insert into public.members (email, school, role, display_name, color, active, added_by, added_at)
select lower(btrim(a.email)), 'cmsru', 'admin', a.display_name, a.color, true, 'multischool migration', a.added_at
from public.admins a
on conflict (school, email) do nothing;

-- Keep the old table as a backup nobody can read through the website, and put
-- a view with the same columns in its place. Today's inbox reads
-- "admins" (email, display_name, color) and updates its own name and color;
-- both keep working through the view, which shows CMSRU's active members.
alter table public.admins rename to admins_pre_multischool;
revoke all on table public.admins_pre_multischool from anon, authenticated, supabase_auth_admin;
comment on table public.admins_pre_multischool is 'Backup of the admins list before the multischool migration (2026-10-13). Not used by anything.';

-- ── Who is who: helpers used by the row rules ───────────────────────────────
-- All run with the owner's rights (so they can read members/site_owners without
-- looping through those tables' own rules) and only ever look at the signed-in email.
create or replace function private.is_site_owner()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.site_owners o where o.email = private.my_email());
$$;

-- The schools I am an active member of (empty for strangers).
create or replace function private.my_schools()
returns text[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(m.school order by m.school), '{}')
  from public.members m where m.email = private.my_email() and m.active;
$$;

-- My role in one school: 'owner' for the site owner, else lead/admin/faculty, else null.
create or replace function private.my_role(p_school text)
returns text language sql stable security definer set search_path = '' as $$
  select case when private.is_site_owner() then 'owner'
              else (select m.role from public.members m
                     where m.school = p_school and m.email = private.my_email() and m.active) end;
$$;

-- In the workspace at all (any school, any role, or the site owner).
create or replace function private.is_member()
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_site_owner()
      or exists (select 1 from public.members m where m.email = private.my_email() and m.active);
$$;

-- May add, remove, and change people of this school: the site owner or its lead.
create or replace function private.can_manage_people(p_school text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(private.my_role(p_school) in ('owner', 'lead'), false);
$$;

-- May plan drafts and curate for this school: owner, lead, or admin (not faculty).
create or replace function private.can_curate(p_school text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(private.my_role(p_school) in ('owner', 'lead', 'admin'), false);
$$;

-- Lead or admin of any school (or the owner): may trash/restore and tag in the shared bank.
create or replace function private.is_curator()
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_site_owner()
      or exists (select 1 from public.members m
                  where m.email = private.my_email() and m.active and m.role in ('lead', 'admin'));
$$;

-- The old "is the signed-in person on the admins list?" now means "a member
-- of any school, or the site owner". Kept under its old name for any rule
-- this file does not rewrite.
create or replace function private.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_member();
$$;

revoke all on function private.is_site_owner(), private.my_schools(), private.my_role(text), private.is_member(),
  private.can_manage_people(text), private.can_curate(text), private.is_curator() from public;
grant execute on function private.is_site_owner(), private.my_schools(), private.my_role(text), private.is_member(),
  private.can_manage_people(text), private.can_curate(text), private.is_curator() to authenticated, service_role;

-- ── The compatibility "admins" view ─────────────────────────────────────────
-- Same columns the current inbox reads. It runs with the reader's rights, so
-- the members rules below decide what shows. Updating display_name or color
-- through it updates that person's CMSRU membership row.
create view public.admins
with (security_invoker = true)
as
  select m.email, m.added_at, m.display_name, m.color
  from public.members m
  where m.school = 'cmsru' and m.active;

-- ── Managing people (site owner, or a school's lead for their own school) ──
-- Nobody ever sets a password here: a new member signs up themselves (the
-- sign-up hook below lets them in because they are on the list).
create or replace function private.need_email()
returns text language plpgsql stable set search_path = '' as $$
begin
  if private.my_email() is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  return private.my_email();
end;
$$;

create or replace function private.clean_email(p text)
returns text language plpgsql immutable set search_path = '' as $$
declare e text := lower(btrim(coalesce(p, '')));
begin
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(e) > 254 then
    raise exception 'That is not an email address.' using errcode = '22023';
  end if;
  return e;
end;
$$;

create or replace function public.add_member(p_email text, p_school text, p_role text, p_display_name text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me text := private.need_email();
  e  text := private.clean_email(p_email);
begin
  if p_role is null or p_role not in ('lead', 'admin', 'faculty') then
    raise exception 'Role must be lead, admin, or faculty.' using errcode = '22023';
  end if;
  if not private.can_manage_people(p_school) then
    raise exception 'Only the site owner or this school''s lead can add people.' using errcode = '42501';
  end if;
  if p_role = 'lead' and not private.is_site_owner() then
    raise exception 'Only the site owner can make someone a school lead.' using errcode = '42501';
  end if;
  if exists (select 1 from public.members m where m.school = p_school and m.email = e) then
    raise exception '% is already listed for this school (restore access instead if it was removed).', e using errcode = '23505';
  end if;
  insert into public.members (email, school, role, display_name, added_by)
  values (e, p_school, p_role, nullif(btrim(p_display_name), ''), me);
  insert into public.member_events (school, actor_email, target_email, action, note)
  values (p_school, me, e, 'member_add', 'as ' || p_role);
end;
$$;

create or replace function public.change_role(p_email text, p_school text, p_role text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me  text := private.need_email();
  e   text := private.clean_email(p_email);
  old text;
begin
  if p_role is null or p_role not in ('lead', 'admin', 'faculty') then
    raise exception 'Role must be lead, admin, or faculty.' using errcode = '22023';
  end if;
  if not private.can_manage_people(p_school) then
    raise exception 'Only the site owner or this school''s lead can change roles.' using errcode = '42501';
  end if;
  select m.role into old from public.members m where m.school = p_school and m.email = e for update;
  if not found then
    raise exception '% is not listed for this school.', e using errcode = 'P0002';
  end if;
  if not private.is_site_owner() and (p_role = 'lead' or old = 'lead') then
    raise exception 'Only the site owner can make or change a school lead.' using errcode = '42501';
  end if;
  if old = p_role then
    return;
  end if;
  update public.members set role = p_role where school = p_school and email = e;
  insert into public.member_events (school, actor_email, target_email, action, note)
  values (p_school, me, e, 'member_role', old || ' -> ' || p_role);
end;
$$;

-- Site owner only: move a membership from one school to another.
create or replace function public.move_school(p_email text, p_from text, p_to text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me text := private.need_email();
  e  text := private.clean_email(p_email);
begin
  if not private.is_site_owner() then
    raise exception 'Only the site owner can move people between schools.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.schools s where s.slug = p_to) then
    raise exception 'No school %.', p_to using errcode = 'P0002';
  end if;
  if exists (select 1 from public.members m where m.school = p_to and m.email = e) then
    raise exception '% is already listed for %.', e, p_to using errcode = '23505';
  end if;
  update public.members set school = p_to where school = p_from and email = e;
  if not found then
    raise exception '% is not listed for %.', e, p_from using errcode = 'P0002';
  end if;
  insert into public.member_events (school, actor_email, target_email, action, note)
  values (p_from, me, e, 'member_move', 'moved to ' || p_to),
         (p_to,   me, e, 'member_move', 'moved from ' || p_from);
end;
$$;

-- Remove (p_active = false) or restore (true) someone's access to one school.
-- Access ends at once: every rule reads this list live. Their sign-in account
-- stays, it just sees nothing.
create or replace function public.set_member_active(p_email text, p_school text, p_active boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me  text := private.need_email();
  e   text := private.clean_email(p_email);
  r   public.members%rowtype;
begin
  if not private.can_manage_people(p_school) then
    raise exception 'Only the site owner or this school''s lead can remove or restore access.' using errcode = '42501';
  end if;
  select * into r from public.members m where m.school = p_school and m.email = e for update;
  if not found then
    raise exception '% is not listed for this school.', e using errcode = 'P0002';
  end if;
  if r.role = 'lead' and not private.is_site_owner() then
    raise exception 'Only the site owner can remove or restore a school lead.' using errcode = '42501';
  end if;
  if r.active = coalesce(p_active, false) then
    return;
  end if;
  update public.members set active = coalesce(p_active, false) where school = p_school and email = e;
  insert into public.member_events (school, actor_email, target_email, action)
  values (p_school, me, e, case when p_active then 'member_restore' else 'member_remove' end);
end;
$$;

-- My own name and color, in every school I belong to.
create or replace function public.set_my_profile(p_display_name text, p_color text)
returns void language plpgsql security definer set search_path = '' as $$
declare me text := private.need_email();
begin
  update public.members set display_name = nullif(btrim(p_display_name), ''), color = p_color
   where email = me;
end;
$$;

revoke all on function private.need_email(), private.clean_email(text) from public;
grant execute on function private.need_email(), private.clean_email(text) to authenticated, service_role;
revoke all on function public.add_member(text, text, text, text), public.change_role(text, text, text),
  public.move_school(text, text, text), public.set_member_active(text, text, boolean),
  public.set_my_profile(text, text) from public, anon;
grant execute on function public.add_member(text, text, text, text), public.change_role(text, text, text),
  public.move_school(text, text, text), public.set_member_active(text, text, boolean),
  public.set_my_profile(text, text) to authenticated;

-- ── Sign-up hook: on the members list (active, any school) or a site owner ─
-- Same function name, so the dashboard hook setting does not need to change.
create or replace function private.hook_signup_admins_only(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  new_email text := lower(trim(coalesce(event -> 'user' ->> 'email', '')));
begin
  if new_email <> '' and (
       exists (select 1 from public.members m where m.email = new_email and m.active)
    or exists (select 1 from public.site_owners o where o.email = new_email)) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message', 'This workspace is only for medical school puzzle groups. Ask your school''s lead to add you.'
    )
  );
end;
$$;

revoke all on function private.hook_signup_admins_only(jsonb) from public, anon, authenticated;
grant execute on function private.hook_signup_admins_only(jsonb) to supabase_auth_admin;
grant select (email, active) on table public.members to supabase_auth_admin;
grant select (email) on table public.site_owners to supabase_auth_admin;

-- ── Submissions become the shared category database ─────────────────────────
alter table public.submissions
  add column trashed_by   text,
  add column trashed_at   timestamptz,
  add column trash_reason text check (trash_reason is null or char_length(trash_reason) <= 2000),
  -- 'studio' = sent in through the Studio; 'published' = imported from a
  -- puzzle that was already live (source_ref = that puzzle id).
  add column source       text not null default 'studio' check (source in ('studio', 'published')),
  add column source_ref   text check (source_ref is null or char_length(source_ref) <= 120);

-- History lines may now be private to one school (comments marked "my school
-- only", and anything that names a draft). null = every member can read it.
alter table public.review_events
  add column school text references public.schools (slug);

update public.review_events set school = 'cmsru'
 where action in ('comment', 'add_to_draft', 'remove_from_draft', 'publish');

-- New status set: new / used / trashed. ("In a draft" is worked out from the
-- slots, not stored.) Shortlisted -> New; Declined -> Trash, keeping who
-- declined it, when, and their note as the reason. No history lines are
-- written for this one-off move (the old lines stay as they were).
alter table public.submissions drop constraint if exists submissions_status_check;
select pg_catalog.set_config('desk.quiet', 'on', false);
update public.submissions set status = 'new' where status = 'shortlisted';
update public.submissions
   set status = 'trashed',
       trashed_by = coalesce(lower(reviewed_by), 'before multischool'),
       trashed_at = coalesce(reviewed_at, created_at),
       trash_reason = admin_note
 where status = 'declined';
select pg_catalog.set_config('desk.quiet', 'off', false);
alter table public.submissions
  add constraint submissions_status_check check (status in ('new', 'used', 'trashed'));
alter table public.submissions
  add constraint submissions_trash_stamped check (status <> 'trashed' or trashed_at is not null);
create index submissions_trashed_at on public.submissions (trashed_at) where status = 'trashed';

-- History actions: the old ones stay readable; new lines use the new set.
alter table public.review_events drop constraint if exists review_events_action_check;
alter table public.review_events
  add constraint review_events_action_check check (action in (
    'submitted', 'used', 'comment', 'vote', 'unvote', 'add_to_draft', 'remove_from_draft', 'publish',
    'trash', 'restore', 'edit', 'undo_edit', 'adapt', 'reopen',
    'shortlist', 'decline'));  -- these two: history from before 2026-10-13 only

create or replace function private.review_event_before()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.action in ('shortlist', 'decline') then
    raise exception 'Shortlist and decline are gone; use Trash.' using errcode = '23514';
  end if;
  -- Anything that names a draft (including "used in <draft>") is only for
  -- that draft's school. Usage counts for everyone come from category_uses.
  if new.school is null and new.draft_id is not null then
    new.school := coalesce(
      (select d.school from public.drafts d where d.id = new.draft_id),
      (select de.school from public.draft_events de where de.draft_id = new.draft_id and de.school is not null limit 1));
  end if;
  return new;
end;
$$;

create trigger review_events_before
  before insert on public.review_events
  for each row execute function private.review_event_before();

-- Only single categories from now on (old full-puzzle rows stay as they are).
create or replace function private.submission_categories_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.kind <> 'category' then
    raise exception 'Full-puzzle suggestions are no longer accepted; send each category on its own.' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger submissions_categories_only
  before insert on public.submissions
  for each row execute function private.submission_categories_only();

-- Stamp who and when, from the sign-in, on any status change; moving to the
-- Trash also stamps trashed_by/at, and leaving it clears them.
create or replace function private.submission_stamp_review()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    if private.my_email() is not null then
      new.reviewed_by := private.my_email();
      new.reviewed_at := pg_catalog.now();
    end if;
    if new.status = 'trashed' then
      new.trashed_by := coalesce(private.my_email(), new.trashed_by, 'database');
      new.trashed_at := pg_catalog.now();
    elsif old.status = 'trashed' then
      new.trashed_by := null;
      new.trashed_at := null;
      new.trash_reason := null;
    end if;
  elsif private.from_website() then
    -- nobody fakes who trashed it
    new.trashed_by := old.trashed_by;
    new.trashed_at := old.trashed_at;
  end if;
  return new;
end;
$$;

create or replace function private.submission_status_logged()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status and not private.quiet() then
    insert into public.review_events (submission_id, actor_email, action, note)
    values (new.id, private.my_email(),
            case when new.status = 'trashed' then 'trash'
                 when old.status = 'trashed' then 'restore'
                 when new.status = 'used' then 'used'
                 else 'reopen' end,
            case when new.status = 'trashed' then new.trash_reason else null end);
  end if;
  return null;
end;
$$;

-- Trash and Restore: any lead or admin of any school (the bank is shared), or
-- the site owner. Faculty cannot. Restore goes back to Used if the category
-- has ever gone out in a puzzle, otherwise to New.
create or replace function public.trash_submission(p_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.need_email();
  if not private.is_curator() then
    raise exception 'Only school leads, admins, and the site owner can move categories to the Trash.' using errcode = '42501';
  end if;
  update public.submissions
     set status = 'trashed', trash_reason = nullif(btrim(p_reason), '')
   where id = p_id and status <> 'trashed';
  if not found and not exists (select 1 from public.submissions s where s.id = p_id) then
    raise exception 'That category does not exist.' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.restore_submission(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.need_email();
  if not private.is_curator() then
    raise exception 'Only school leads, admins, and the site owner can restore from the Trash.' using errcode = '42501';
  end if;
  update public.submissions s
     set status = case when s.used_in is not null
                         or exists (select 1 from public.category_uses u where u.submission_id = s.id)
                       then 'used' else 'new' end
   where s.id = p_id and s.status = 'trashed';
end;
$$;

revoke all on function private.review_event_before(), private.submission_categories_only() from public;
revoke all on function public.trash_submission(uuid, text), public.restore_submission(uuid) from public, anon;
grant execute on function public.trash_submission(uuid, text), public.restore_submission(uuid) to authenticated;
grant update (trash_reason) on table public.submissions to authenticated;

-- ── Fixing an original: logged, undoable ────────────────────────────────────
-- One row per changed field. path is a dotted path into the category, e.g.
-- 'name', 'explanation', 'items.2.label', 'items.0.info.text'.
create table public.submission_edits (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions (id) on delete cascade,
  editor_email  text not null,
  path          text not null check (char_length(path) <= 40),
  old_value     jsonb,              -- null = the field was not there
  new_value     jsonb,              -- null = the field was removed
  at            timestamptz not null default now(),
  undone_by     text,
  undone_at     timestamptz
);
create index submission_edits_submission_at on public.submission_edits (submission_id, at desc);

-- Which fields may be fixed, and how long each may be (the Studio's limits).
create or replace function private.edit_limit(p_path text)
returns int language sql immutable set search_path = '' as $$
  select case
    when p_path = 'name' then 120
    when p_path = 'explanation' then 400
    when p_path ~ '^items\.[0-3]\.label$' then 80
    when p_path ~ '^items\.[0-3]\.note$' then 280
    when p_path ~ '^items\.[0-3]\.source$' then 300
    when p_path ~ '^items\.[0-3]\.info\.text$' then 1500
  end;
$$;

-- Writes one value into a category (null removes it). A clue's label is also
-- its info.title, so the two stay the same.
create or replace function private.put_field(p_payload jsonb, p_path text, p_value jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  k   text[] := pg_catalog.string_to_array(p_path, '.');
  out jsonb := p_payload;
begin
  if p_value is null or p_value = 'null'::jsonb then
    return out #- k;
  end if;
  if p_path ~ '\.info\.text$' and jsonb_typeof(out #> k[1:3]) is distinct from 'object' then
    out := pg_catalog.jsonb_set(out, k[1:3], '{}'::jsonb, true);
  end if;
  out := pg_catalog.jsonb_set(out, k, p_value, true);
  if p_path ~ '\.label$' and jsonb_typeof(out #> (k[1:2] || '{info}'::text[])) = 'object' then
    out := pg_catalog.jsonb_set(out, k[1:2] || '{info,title}'::text[], p_value, true);
  end if;
  return out;
end;
$$;

-- May fix originals sent to this school: its leads and admins, and the site owner.
create or replace function private.can_edit_original(p_submission uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select private.my_role(s.school) in ('owner', 'lead', 'admin')
                   from public.submissions s where s.id = p_submission), false);
$$;

-- edit_submission(id, {"name": "...", "items.1.label": "...", "items.0.note": null})
-- Returns how many fields actually changed.
create or replace function public.edit_submission(p_id uuid, p_patch jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare
  me   text := private.need_email();
  s    public.submissions%rowtype;
  pay  jsonb;
  k    text;
  v    jsonb;
  oldv jsonb;
  lim  int;
  n    int := 0;
  done text[] := '{}';
begin
  select * into s from public.submissions where id = p_id for update;
  if not found then
    raise exception 'That category does not exist.' using errcode = 'P0002';
  end if;
  if not private.can_edit_original(p_id) then
    raise exception 'Only the receiving school''s leads and admins (or the site owner) can fix the original.' using errcode = '42501';
  end if;
  if s.kind <> 'category' then
    raise exception 'Old full-puzzle suggestions cannot be edited here.' using errcode = '23514';
  end if;
  if jsonb_typeof(p_patch) is distinct from 'object' or p_patch = '{}'::jsonb then
    raise exception 'Send the changes as {"field": "new text"}.' using errcode = '22023';
  end if;
  pay := s.payload;
  for k, v in select * from pg_catalog.jsonb_each(p_patch) loop
    lim := private.edit_limit(k);
    if lim is null then
      raise exception 'The field % cannot be edited.', k using errcode = '22023';
    end if;
    if k ~ '^items\.' and pg_catalog.split_part(k, '.', 2)::int >= coalesce(jsonb_array_length(pay -> 'items'), 0) then
      raise exception 'There is no clue %.', pg_catalog.split_part(k, '.', 2)::int + 1 using errcode = '22023';
    end if;
    if v = 'null'::jsonb then
      v := null;
    elsif jsonb_typeof(v) <> 'string' then
      raise exception '% must be text.', k using errcode = '22023';
    else
      v := to_jsonb(pg_catalog.btrim(v #>> '{}'));
      if v = '""'::jsonb then v := null; end if;
    end if;
    if v is null and k ~ '^(name|explanation)$|\.label$' then
      raise exception '% cannot be empty.', k using errcode = '22023';
    end if;
    if v is not null and char_length(v #>> '{}') > lim then
      raise exception '% is too long (max % characters).', k, lim using errcode = '22001';
    end if;
    oldv := pay #> pg_catalog.string_to_array(k, '.');
    if oldv is not distinct from v then
      continue;
    end if;
    pay := private.put_field(pay, k, v);
    insert into public.submission_edits (submission_id, editor_email, path, old_value, new_value)
    values (p_id, me, k, oldv, v);
    n := n + 1;
    done := done || k;
  end loop;
  if n > 0 then
    update public.submissions
       set payload = pay, group_name = coalesce(pay ->> 'name', group_name)
     where id = p_id;
    insert into public.review_events (submission_id, actor_email, action, note)
    values (p_id, me, 'edit', 'edited ' || pg_catalog.array_to_string(done, ', '));
  end if;
  return n;
end;
$$;

-- Puts one field back. Refused if someone changed that field again since.
create or replace function public.undo_submission_edit(p_edit_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me  text := private.need_email();
  e   public.submission_edits%rowtype;
  pay jsonb;
begin
  select * into e from public.submission_edits where id = p_edit_id for update;
  if not found then
    raise exception 'That edit does not exist.' using errcode = 'P0002';
  end if;
  if not private.can_edit_original(e.submission_id) then
    raise exception 'Only the receiving school''s leads and admins (or the site owner) can undo fixes.' using errcode = '42501';
  end if;
  if e.undone_at is not null then
    raise exception 'That edit was already undone.' using errcode = '55000';
  end if;
  select payload into pay from public.submissions where id = e.submission_id for update;
  if (pay #> pg_catalog.string_to_array(e.path, '.')) is distinct from e.new_value then
    raise exception '% was changed again after this edit; undo the newer edit first.', e.path using errcode = '55000';
  end if;
  pay := private.put_field(pay, e.path, e.old_value);
  update public.submissions
     set payload = pay, group_name = coalesce(pay ->> 'name', group_name)
   where id = e.submission_id;
  update public.submission_edits set undone_by = me, undone_at = pg_catalog.now() where id = p_edit_id;
  insert into public.review_events (submission_id, actor_email, action, note)
  values (e.submission_id, me, 'undo_edit', 'undid edit of ' || e.path);
end;
$$;

revoke all on function private.edit_limit(text), private.put_field(jsonb, text, jsonb), private.can_edit_original(uuid) from public;
grant execute on function private.can_edit_original(uuid) to authenticated, service_role;
revoke all on function public.edit_submission(uuid, jsonb), public.undo_submission_edit(uuid) from public, anon;
grant execute on function public.edit_submission(uuid, jsonb), public.undo_submission_edit(uuid) to authenticated;

-- ── Drafts belong to one school ─────────────────────────────────────────────
alter table public.drafts alter column school drop default;
alter table public.drafts
  add column faculty_approved_by text,
  add column faculty_approved_at timestamptz;

alter table public.draft_events
  add column school text references public.schools (slug);
update public.draft_events de
   set school = coalesce((select d.school from public.drafts d where d.id = de.draft_id), 'cmsru');
alter table public.draft_events drop constraint if exists draft_events_action_check;
alter table public.draft_events
  add constraint draft_events_action_check check (action in ('create', 'rename', 'status', 'schedule', 'unschedule', 'deleted',
    'comment', 'lost_slot', 'reverted', 'publish_requested', 'publish', 'approve', 'unapprove'));
create index draft_events_school_at on public.draft_events (school, at desc);

-- A draft's history line always carries the draft's school (looked up from
-- the draft, or from its earlier lines once the draft has been deleted).
create or replace function private.draft_event_before()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.school is null then
    new.school := coalesce(
      (select d.school from public.drafts d where d.id = new.draft_id),
      (select de.school from public.draft_events de where de.draft_id = new.draft_id and de.school is not null limit 1));
  end if;
  return new;
end;
$$;

create trigger draft_events_before
  before insert on public.draft_events
  for each row execute function private.draft_event_before();

-- Small lookups the rules use (owner's rights, so drafts' own rules don't loop).
create or replace function private.draft_school(p_draft uuid)
returns text language sql stable security definer set search_path = '' as $$
  select d.school from public.drafts d where d.id = p_draft;
$$;

create or replace function private.can_read_draft(p_draft uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_site_owner() or coalesce(private.draft_school(p_draft) = any (private.my_schools()), false);
$$;

create or replace function private.can_edit_draft(p_draft uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.can_curate(private.draft_school(p_draft));
$$;

-- Who may own a draft: a lead or admin of its school, or a site owner.
create or replace function private.can_own_draft(p_email text, p_school text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.site_owners o where o.email = lower(btrim(p_email)))
      or exists (select 1 from public.members m
                  where m.email = lower(btrim(p_email)) and m.school = p_school
                    and m.active and m.role in ('lead', 'admin'));
$$;

-- The school a new draft goes to when the page does not say: my first school
-- where I can plan (today's inbox never says, and gets CMSRU).
create or replace function private.my_planning_school()
returns text language sql stable security definer set search_path = '' as $$
  select m.school from public.members m
   where m.email = private.my_email() and m.active and m.role in ('lead', 'admin')
   order by (m.school = 'cmsru') desc, m.school limit 1;
$$;

revoke all on function private.draft_event_before(), private.draft_school(uuid), private.can_read_draft(uuid),
  private.can_edit_draft(uuid), private.can_own_draft(text, text), private.my_planning_school() from public;
grant execute on function private.draft_school(uuid), private.can_read_draft(uuid), private.can_edit_draft(uuid),
  private.can_own_draft(text, text), private.my_planning_school() to authenticated, service_role;

-- Same rules as before, plus: a draft's school is set once (by the page or
-- from my planning school) and never changes; the owner must be able to plan
-- in that school; approval fields are set only by approve_draft().
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
  if tg_op = 'INSERT' then
    new.school := coalesce(new.school, private.my_planning_school());
    if new.school is null then
      raise exception 'Pick which school this draft is for.' using errcode = '23502';
    end if;
  elsif new.school is distinct from old.school then
    raise exception 'A draft cannot move to another school.' using errcode = '42501';
  end if;
  if web then
    if tg_op = 'INSERT' then
      new.created_at := pg_catalog.now();
      new.faculty_approved_by := null;
      new.faculty_approved_at := null;
    else
      new.faculty_approved_by := old.faculty_approved_by;
      new.faculty_approved_at := old.faculty_approved_at;
    end if;
    if new.status = 'published' then
      raise exception 'Only the publishing job can mark a draft Published. Use Publish now.' using errcode = '42501';
    end if;
    if not private.can_own_draft(new.owner_email, new.school) then
      raise exception 'The owner must be a lead or admin of this draft''s school.' using errcode = '23514';
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

-- Faculty approval: optional, never blocks anything. The draft's school's
-- faculty (or the site owner) may approve or take it back.
create or replace function private.set_approval(p_draft uuid, p_on boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me text := private.need_email();
  d  public.drafts%rowtype;
begin
  select * into d from public.drafts where id = p_draft for update;
  if not found or not private.can_read_draft(p_draft) then
    raise exception 'That draft does not exist.' using errcode = 'P0002';
  end if;
  if coalesce(private.my_role(d.school) not in ('owner', 'faculty'), true) then
    raise exception 'Only faculty (or the site owner) can approve drafts.' using errcode = '42501';
  end if;
  if d.status = 'published' then
    raise exception 'A published draft can no longer be changed.' using errcode = '42501';
  end if;
  -- Taking back an approval that isn't there does nothing. Approving again
  -- (after the draft changed) re-stamps who and when: a "re-approve".
  if not p_on and d.faculty_approved_at is null then
    return;
  end if;
  update public.drafts
     set faculty_approved_by = case when p_on then me end,
         faculty_approved_at = case when p_on then pg_catalog.now() end
   where id = p_draft;
  insert into public.draft_events (draft_id, draft_title, actor_email, action, school)
  values (d.id, d.title, me, case when p_on then 'approve' else 'unapprove' end, d.school);
end;
$$;

create or replace function public.approve_draft(p_draft_id uuid)
returns void language sql security definer set search_path = '' as $$
  select private.set_approval(p_draft_id, true);
$$;

create or replace function public.unapprove_draft(p_draft_id uuid)
returns void language sql security definer set search_path = '' as $$
  select private.set_approval(p_draft_id, false);
$$;

revoke all on function private.set_approval(uuid, boolean) from public;
revoke all on function public.approve_draft(uuid), public.unapprove_draft(uuid) from public, anon;
grant execute on function public.approve_draft(uuid), public.unapprove_draft(uuid) to authenticated;
grant insert (school) on table public.drafts to authenticated;

-- ── Adapted copies inside a draft ───────────────────────────────────────────
-- A filled slot normally shows its category as-is (adapted is null). When the
-- school tailors it for this puzzle, adapted holds the whole changed copy:
-- { name, explanation, items: [4 clues: label, zone, note, info{text,image},
-- scope{image}, source] }, while submission_id still points at the original.
-- Replacement images live in the private bucket under drafts/<draft id>/...
alter table public.draft_slots
  add column adapted jsonb
    check (adapted is null or (jsonb_typeof(adapted) = 'object' and octet_length(adapted::text) <= 100000)),
  add constraint draft_slots_adapted_needs_source check (adapted is null or submission_id is not null);

-- Every image a category (or a copy of it) points at.
create or replace function private.image_paths(p jsonb)
returns setof text language sql immutable set search_path = '' as $$
  select v #>> '{}'
  from pg_catalog.jsonb_path_query(coalesce(p, '{}'::jsonb),
         'lax $.items[*].**{0 to 2}.image'::jsonpath) as v
  where pg_catalog.jsonb_typeof(v) = 'string';
$$;

create or replace function private.slot_before()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  web boolean := private.from_website();
  k   text;
  st  text;
  img text;
  bad text;
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
    select s.kind, s.status into k, st from public.submissions s where s.id = new.submission_id;
    if k = 'puzzle' and new.group_index is null then
      raise exception 'Pick which group of the full puzzle goes in this slot (group_index 0-3).' using errcode = '23514';
    elsif k = 'category' and new.group_index is not null then
      raise exception 'group_index is only for full-puzzle suggestions.' using errcode = '23514';
    end if;
    if web and st = 'trashed' and (tg_op = 'INSERT' or new.submission_id is distinct from old.submission_id) then
      raise exception 'That category is in the Trash. Restore it first.' using errcode = '23514';
    end if;
  end if;
  if new.adapted is not null and (tg_op = 'INSERT' or new.adapted is distinct from old.adapted) then
    if jsonb_typeof(new.adapted -> 'name') is distinct from 'string'
       or char_length(pg_catalog.btrim(new.adapted ->> 'name')) not between 1 and 120
       or jsonb_typeof(new.adapted -> 'items') is distinct from 'array'
       or jsonb_array_length(new.adapted -> 'items') <> 4
       or exists (select 1 from pg_catalog.jsonb_array_elements(new.adapted -> 'items') c
                   where jsonb_typeof(c -> 'label') is distinct from 'string'
                      or char_length(pg_catalog.btrim(c ->> 'label')) not between 1 and 80) then
      raise exception 'An adapted copy needs a name and 4 clues, each with a label.' using errcode = '23514';
    end if;
    -- Images: a copy may keep any image of the category it came from, use a
    -- clue swapped in from another category of the shared database (every
    -- member can already read those), or a new one uploaded for this draft
    -- (drafts/<draft id>/...). Never another draft's uploads.
    for img in select private.image_paths(new.adapted) loop
      if img not like 'drafts/' || new.draft_id::text || '/%'
         and (img like 'drafts/%'
              or not exists (select 1 from public.submissions s
                              where img in (select private.image_paths(s.payload)))) then
        bad := img;
        exit;
      end if;
    end loop;
    if bad is not null then
      raise exception 'Image % is not from this category or this draft''s uploads.', left(bad, 120) using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

-- History lines on the suggestion, as before, plus "adapted" when a copy is
-- made or changed. (Draft-related lines are private to the draft's school.)
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
    if new.adapted is not null and (tg_op = 'INSERT' or new.adapted is distinct from old.adapted) then
      insert into public.review_events (submission_id, actor_email, action, note, draft_id)
      values (new.submission_id, who, 'adapt',
              case when tg_op = 'UPDATE' and old.adapted is not null then 'changed its adapted copy in ' else 'adapted a copy for ' end || title,
              new.draft_id);
    elsif tg_op = 'UPDATE' and new.adapted is null and old.adapted is not null
          and new.submission_id is not distinct from old.submission_id then
      insert into public.review_events (submission_id, actor_email, action, note, draft_id)
      values (new.submission_id, who, 'adapt', 'went back to the original in ' || title, new.draft_id);
    end if;
  end if;
  return null;
end;
$$;

revoke all on function private.image_paths(jsonb) from public;
grant execute on function private.image_paths(jsonb) to authenticated, service_role;
grant insert (adapted), update (adapted) on table public.draft_slots to authenticated;

-- ── Comments: per school, "my school only" or "all schools" ────────────────
-- Old comments were all CMSRU's and stay CMSRU-only.
alter table public.comments
  add column school text references public.schools (slug),
  add column visibility text not null default 'school' check (visibility in ('school', 'all'));
update public.comments set school = 'cmsru' where school is null;
alter table public.comments alter column school set not null;
alter table public.comments alter column visibility drop default;
create index comments_school on public.comments (school);

-- The school I speak for: the one asked for if I belong to it, else my first
-- school (CMSRU first), else (a site owner with no school) the fallback.
create or replace function private.my_school_or(p_wanted text, p_fallback text)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select p_wanted where p_wanted = any (private.my_schools())),
    (select x from unnest(private.my_schools()) x order by (x = 'cmsru') desc, x limit 1),
    p_fallback);
$$;
revoke all on function private.my_school_or(text, text) from public;
grant execute on function private.my_school_or(text, text) to authenticated, service_role;

-- Author, time and school come from the sign-in. A comment on a draft always
-- belongs to the draft's school and stays inside it. A comment on a category
-- takes the school's default visibility unless the page picks one. Visibility
-- is fixed once posted (its copy in the history was written with it).
create or replace function private.comment_before()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  sub_school text;
begin
  if tg_op = 'INSERT' then
    if private.from_website() then
      new.author_email := private.my_email();
      new.at := pg_catalog.now();
      new.edited_at := null;
    end if;
    if new.target_type = 'submission' then
      select s.school into sub_school from public.submissions s where s.id = new.target_id;
      if not found then
        raise exception 'That suggestion does not exist.' using errcode = '23503';
      end if;
      if private.from_website() then
        new.school := private.my_school_or(new.school, sub_school);
      end if;
      new.school := coalesce(new.school, sub_school);
      new.visibility := coalesce(new.visibility,
        (select ss.comment_default from public.school_settings ss where ss.school = new.school), 'school');
    else
      new.school := private.draft_school(new.target_id);
      if new.school is null or not private.can_read_draft(new.target_id) and private.from_website() then
        raise exception 'That draft does not exist.' using errcode = '23503';
      end if;
      new.visibility := 'school';
    end if;
  else
    new.school := old.school;
    new.visibility := old.visibility;
    if new.body is distinct from old.body then
      new.edited_at := pg_catalog.now();
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.comment_logged()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.target_type = 'submission' then
    insert into public.review_events (submission_id, actor_email, action, note, at, school)
    values (new.target_id, new.author_email, 'comment', left(new.body, 280), new.at,
            case when new.visibility = 'school' then new.school end);
  else
    insert into public.draft_events (draft_id, draft_title, actor_email, action, note, at, school)
    select d.id, d.title, new.author_email, 'comment', left(new.body, 280), new.at, d.school
    from public.drafts d where d.id = new.target_id;
  end if;
  return null;
end;
$$;

grant insert (school, visibility) on table public.comments to authenticated;

-- ── Votes remember the voter's school ───────────────────────────────────────
alter table public.votes add column school text references public.schools (slug);
update public.votes set school = 'cmsru' where school is null;
create index votes_submission_school on public.votes (submission_id, school);

create or replace function private.vote_before()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if private.from_website() then
    new.voter_email := private.my_email();
    new.at := pg_catalog.now();
    new.school := private.my_school_or(new.school, null);
  end if;
  return new;
end;
$$;

grant insert (school) on table public.votes to authenticated;

-- ── Usage: one row each time a category goes out in a published puzzle ─────
create table public.category_uses (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions (id) on delete cascade,
  school        text not null references public.schools (slug),
  draft_id      uuid,                    -- null for puzzles imported from before the workspace
  puzzle_id     text not null check (char_length(puzzle_id) <= 120),
  puzzle_date   date,
  adapted       boolean not null default false,
  published_at  timestamptz not null default now(),
  constraint category_uses_once unique (submission_id, puzzle_id)
);
create index category_uses_school on public.category_uses (school, published_at desc);

-- Publishing, as before (mark Used, take the categories out of other drafts,
-- Scheduled -> Ready and Ready -> Planning for drafts that lost one, tell
-- their owners), plus a category_uses row per category (adapted = the slot
-- held a tailored copy). Only drafts of the SAME school lose the category:
-- another school may still use it in its own puzzle.
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

  -- 1. Used, and one usage row each
  update public.submissions
     set status = 'used', used_in = d.published_puzzle_id,
         reviewed_by = coalesce(who, 'publishing job'), reviewed_at = pg_catalog.now()
   where id = any (ids);
  insert into public.review_events (submission_id, actor_email, action, note, draft_id)
  select x, who, 'publish', 'used in ' || d.title || ' (' || d.published_puzzle_id || ')', p_draft_id
  from unnest(ids) as x;
  insert into public.category_uses (submission_id, school, draft_id, puzzle_id, puzzle_date, adapted, published_at)
  select s.submission_id, d.school, d.id, d.published_puzzle_id,
         case when d.published_puzzle_id ~ '[0-9]{4}-[0-9]{2}-[0-9]{2}$'
              then pg_catalog.to_date(right(d.published_puzzle_id, 10), 'YYYY-MM-DD') end,
         bool_or(s.adapted is not null), coalesce(d.published_at, pg_catalog.now())
  from public.draft_slots s
  where s.draft_id = p_draft_id and s.submission_id is not null
  group by s.submission_id
  on conflict (submission_id, puzzle_id) do nothing;

  -- 2. Out of the same school's other drafts (remember which drafts were hit first)
  select coalesce(array_agg(distinct s.draft_id), '{}') into hit
  from public.draft_slots s join public.drafts o on o.id = s.draft_id
  where s.submission_id = any (ids) and o.id <> p_draft_id and o.status <> 'published' and o.school = d.school;

  with gone as (
    delete from public.draft_slots s
     using public.drafts o
     where o.id = s.draft_id and s.submission_id = any (ids)
       and o.id <> p_draft_id and o.status <> 'published' and o.school = d.school
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

  -- 3. Drafts that lost a category step back: Scheduled -> Ready, Ready -> Planning.
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

-- Per category: times used (as-is / adapted), which schools used it, and how
-- many unpublished drafts it sits in (only drafts the reader may see count).
create view public.category_usage
with (security_invoker = true)
as
  select s.id as submission_id,
         (select count(*) from public.category_uses u where u.submission_id = s.id)::int as times_used,
         (select count(*) from public.category_uses u where u.submission_id = s.id and not u.adapted)::int as as_is,
         (select count(*) from public.category_uses u where u.submission_id = s.id and u.adapted)::int as adapted,
         coalesce((select array_agg(distinct u.school order by u.school) from public.category_uses u
                    where u.submission_id = s.id), '{}') as schools,
         (select count(distinct ds.draft_id) from public.draft_slots ds
            join public.drafts d on d.id = ds.draft_id
           where ds.submission_id = s.id and d.status <> 'published')::int as drafts_count
  from public.submissions s;

-- ── Other schools' release days (no titles, ids, or blocks) ────────────────
-- "Rowan-Virtua has a puzzle releasing Thu Oct 22": school name and day only.
create or replace function public.other_school_releases(p_from date, p_to date)
returns table (school_name text, release_date date)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_member() then
    raise exception 'Workspace members only.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'Ask for at most 400 days at a time.' using errcode = '22023';
  end if;
  return query
    select distinct sc.name, (d.target_release at time zone 'America/New_York')::date
    from public.drafts d join public.schools sc on sc.slug = d.school
    where d.status = 'scheduled'
      and d.school <> all (private.my_schools())
      and (d.target_release at time zone 'America/New_York')::date between p_from and p_to
    order by 2, 1;
end;
$$;

revoke all on function public.other_school_releases(date, date) from public, anon;
grant execute on function public.other_school_releases(date, date) to authenticated;

-- Names and colors of everyone in the workspace (for avatars on comments and
-- votes from other schools), without exposing roles or who added whom.
create or replace function public.member_names()
returns table (email text, display_name text, color text, schools text[])
language sql stable security definer set search_path = '' as $$
  select m.email, max(m.display_name), max(m.color), array_agg(m.school order by m.school)
  from public.members m
  where m.active and private.is_member()
  group by m.email;
$$;

revoke all on function public.member_names() from public, anon;
grant execute on function public.member_names() to authenticated;

-- ── Settings ────────────────────────────────────────────────────────────────
create table public.school_settings (
  school          text primary key references public.schools (slug) on delete cascade,
  faculty_badge   boolean not null default true,     -- show the "Faculty approved" seal
  comment_default text not null default 'school' check (comment_default in ('school', 'all')),
  updated_by      text,
  updated_at      timestamptz not null default now()
);
insert into public.school_settings (school) select slug from public.schools on conflict do nothing;

-- One row. trash_retention_days null = keep the Trash forever (the default).
create table public.site_settings (
  id                   boolean primary key default true check (id),
  trash_retention_days int check (trash_retention_days is null or trash_retention_days between 1 and 3650),
  updated_by           text,
  updated_at           timestamptz not null default now()
);
insert into public.site_settings (id) values (true) on conflict do nothing;

create or replace function private.settings_stamp()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_by := private.my_email();
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;
create trigger school_settings_stamp before update on public.school_settings
  for each row execute function private.settings_stamp();
create trigger site_settings_stamp before update on public.site_settings
  for each row execute function private.settings_stamp();

-- A new school gets its settings row straight away.
create or replace function private.school_added()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.school_settings (school) values (new.slug) on conflict do nothing;
  return null;
end;
$$;
create trigger schools_settings_row after insert on public.schools
  for each row execute function private.school_added();

-- Empties the Trash of anything older than the setting. Does nothing while the
-- setting is "never". Keeps (does not delete) a trashed category that has gone
-- out in a puzzle or still sits in any draft, so no puzzle record loses a slot.
-- The images in storage are NOT removed (SQL can't); see SETUP.md.
-- Ready for pg_cron, but not scheduled here (see SETUP.md).
create or replace function private.purge_trash()
returns int language plpgsql security definer set search_path = '' as $$
declare
  days int := (select s.trash_retention_days from public.site_settings s where s.id);
  n int;
begin
  if days is null then
    return 0;
  end if;
  delete from public.submissions s
   where s.status = 'trashed'
     and s.trashed_at < pg_catalog.now() - pg_catalog.make_interval(days => days)
     and not exists (select 1 from public.category_uses u where u.submission_id = s.id)
     and not exists (select 1 from public.draft_slots ds where ds.submission_id = s.id);
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function private.settings_stamp(), private.school_added(), private.purge_trash() from public, anon, authenticated;
grant execute on function private.purge_trash() to service_role;

-- ── Activity feed, per school ───────────────────────────────────────────────
-- Same columns as before plus school (whose line it is) and school_only
-- (true = only that school can see it). The rules on each history table decide
-- what a reader gets; the site owner sees everything.
drop view if exists public.activity;
create view public.activity
with (security_invoker = true)
as
  select e.at, e.actor_email, 'submission'::text as subject, e.action, e.note,
         e.submission_id, e.draft_id, s.group_name as subject_name, null::text as notify_email,
         coalesce(e.school, s.school) as school, (e.school is not null) as school_only
  from public.review_events e
  join public.submissions s on s.id = e.submission_id
  union all
  select de.at, de.actor_email, 'draft'::text, de.action, de.note,
         null::uuid, de.draft_id, de.draft_title, de.notify_email, de.school, true
  from public.draft_events de
  union all
  select me.at, me.actor_email, 'member'::text, me.action, me.note,
         null::uuid, null::uuid, me.target_email, null::text, me.school, true
  from public.member_events me;

-- ── Lock everything down ────────────────────────────────────────────────────
alter table public.schools          enable row level security;
alter table public.site_owners      enable row level security;
alter table public.members          enable row level security;
alter table public.member_events    enable row level security;
alter table public.submission_edits enable row level security;
alter table public.category_uses    enable row level security;
alter table public.school_settings  enable row level security;
alter table public.site_settings    enable row level security;

revoke all on table public.schools, public.site_owners, public.members, public.member_events,
  public.submission_edits, public.category_uses, public.school_settings, public.site_settings,
  public.admins, public.category_usage, public.activity from anon, authenticated;

grant select on table public.schools, public.site_owners, public.members, public.member_events,
  public.submission_edits, public.category_uses, public.school_settings, public.site_settings,
  public.admins, public.category_usage, public.activity to authenticated;
grant insert (slug, name, status), update (name, status) on table public.schools to authenticated;
grant update (display_name, color) on table public.members, public.admins to authenticated;
grant update (faculty_badge, comment_default) on table public.school_settings to authenticated;
grant update (trash_retention_days) on table public.site_settings to authenticated;

-- People and schools
create policy "Members can see the schools" on public.schools
  for select to authenticated using ((select private.is_member()));
create policy "The site owner adds schools" on public.schools
  for insert to authenticated with check ((select private.is_site_owner()));
create policy "The site owner edits schools" on public.schools
  for update to authenticated using ((select private.is_site_owner())) with check ((select private.is_site_owner()));

create policy "The site owner sees the owners list" on public.site_owners
  for select to authenticated using ((select private.is_site_owner()));
create policy "Auth can check site owners at sign-up" on public.site_owners
  for select to supabase_auth_admin using (true);

create policy "Members see their own schools' people" on public.members
  for select to authenticated
  using ((select private.is_site_owner()) or school = any ((select private.my_schools())::text[]));
create policy "Members set their own name and color" on public.members
  for update to authenticated
  using (email = (select private.my_email()) and active)
  with check (email = (select private.my_email()));
create policy "Auth can check members at sign-up" on public.members
  for select to supabase_auth_admin using (true);

create policy "Members see their schools' people changes" on public.member_events
  for select to authenticated
  using ((select private.is_site_owner()) or school = any ((select private.my_schools())::text[]));

-- The shared category database
drop policy if exists "Admins can read submissions" on public.submissions;
drop policy if exists "Admins can review submissions" on public.submissions;
create policy "Members can read the category database" on public.submissions
  for select to authenticated using ((select private.is_member()));
create policy "Leads and admins can review categories" on public.submissions
  for update to authenticated using ((select private.is_curator())) with check ((select private.is_curator()));

create policy "Members can read edit history" on public.submission_edits
  for select to authenticated using ((select private.is_member()));
create policy "Members can read usage" on public.category_uses
  for select to authenticated using ((select private.is_member()));

drop policy if exists "Admins can read suggestion history" on public.review_events;
create policy "Members read shared and own-school history" on public.review_events
  for select to authenticated
  using ((select private.is_site_owner())
         or ((select private.is_member()) and (school is null or school = any ((select private.my_schools())::text[]))));

-- Settings
create policy "Members read their school settings" on public.school_settings
  for select to authenticated
  using ((select private.is_site_owner()) or school = any ((select private.my_schools())::text[]));
create policy "Leads and the owner change school settings" on public.school_settings
  for update to authenticated
  using (private.can_manage_people(school)) with check (private.can_manage_people(school));
create policy "Members read site settings" on public.site_settings
  for select to authenticated using ((select private.is_member()));
create policy "The site owner changes site settings" on public.site_settings
  for update to authenticated
  using ((select private.is_site_owner())) with check ((select private.is_site_owner()));

-- Drafts and everything hanging off them: the draft's school only (+ owner).
drop policy if exists "Admins can read drafts" on public.drafts;
drop policy if exists "Admins can make drafts" on public.drafts;
drop policy if exists "Admins can edit drafts" on public.drafts;
drop policy if exists "Admins can delete drafts" on public.drafts;
create policy "School members read their drafts" on public.drafts
  for select to authenticated
  using ((select private.is_site_owner()) or school = any ((select private.my_schools())::text[]));
create policy "Leads and admins make drafts" on public.drafts
  for insert to authenticated with check (private.can_curate(school));
create policy "Leads and admins edit drafts" on public.drafts
  for update to authenticated using (private.can_curate(school)) with check (private.can_curate(school));
create policy "Leads and admins delete drafts" on public.drafts
  for delete to authenticated using (private.can_curate(school));

drop policy if exists "Admins can read slots" on public.draft_slots;
drop policy if exists "Admins can fill slots" on public.draft_slots;
drop policy if exists "Admins can change slots" on public.draft_slots;
drop policy if exists "Admins can empty slots" on public.draft_slots;
create policy "School members read slots" on public.draft_slots
  for select to authenticated using (private.can_read_draft(draft_id));
create policy "Leads and admins fill slots" on public.draft_slots
  for insert to authenticated with check (private.can_edit_draft(draft_id));
create policy "Leads and admins change slots" on public.draft_slots
  for update to authenticated using (private.can_edit_draft(draft_id)) with check (private.can_edit_draft(draft_id));
create policy "Leads and admins empty slots" on public.draft_slots
  for delete to authenticated using (private.can_edit_draft(draft_id));

drop policy if exists "Admins can read draft history" on public.draft_events;
create policy "School members read draft history" on public.draft_events
  for select to authenticated
  using ((select private.is_site_owner()) or school = any ((select private.my_schools())::text[]));

drop policy if exists "Admins can read publish jobs" on public.publish_jobs;
drop policy if exists "Admins can ask to publish now" on public.publish_jobs;
create policy "School members read publish jobs" on public.publish_jobs
  for select to authenticated using (private.can_read_draft(draft_id));
create policy "Leads and admins ask to publish now" on public.publish_jobs
  for insert to authenticated
  with check (private.can_edit_draft(draft_id) and kind = 'now' and requested_by = (select private.my_email()));

-- Comments: draft comments stay in the draft's school; category comments are
-- "all schools" or the writer's school only.
drop policy if exists "Admins can read comments" on public.comments;
drop policy if exists "Admins can comment as themselves" on public.comments;
drop policy if exists "Admins can edit their own comments" on public.comments;
drop policy if exists "Admins can delete their own comments" on public.comments;
create policy "Members read the comments meant for them" on public.comments
  for select to authenticated
  using ((select private.is_site_owner())
         or (target_type = 'draft' and private.can_read_draft(target_id))
         or (target_type = 'submission' and (select private.is_member())
             and (visibility = 'all' or school = any ((select private.my_schools())::text[]))));
create policy "Members comment as themselves" on public.comments
  for insert to authenticated
  with check ((select private.is_member()) and author_email = (select private.my_email())
              and (target_type = 'submission' or private.can_read_draft(target_id)));
create policy "Members edit their own comments" on public.comments
  for update to authenticated
  using ((select private.is_member()) and author_email = (select private.my_email()))
  with check (author_email = (select private.my_email()));
create policy "Members delete their own comments" on public.comments
  for delete to authenticated
  using ((select private.is_member()) and author_email = (select private.my_email()));

-- Votes: one per person per category, as before.
drop policy if exists "Admins can read votes" on public.votes;
drop policy if exists "Admins can vote as themselves" on public.votes;
drop policy if exists "Admins can take back their own vote" on public.votes;
create policy "Members read votes" on public.votes
  for select to authenticated using ((select private.is_member()));
create policy "Members vote as themselves" on public.votes
  for insert to authenticated
  with check ((select private.is_member()) and voter_email = (select private.my_email()));
create policy "Members take back their own vote" on public.votes
  for delete to authenticated
  using ((select private.is_member()) and voter_email = (select private.my_email()));

-- ── Images ──────────────────────────────────────────────────────────────────
-- Same private bucket. Students' originals: any member reads them. Images for
-- an adapted copy go under drafts/<draft id>/<file>; only that draft's school
-- (and the site owner) can see them, and its leads/admins can upload/replace.
create or replace function private.path_draft(p_name text)
returns uuid language sql immutable set search_path = '' as $$
  select case when p_name ~ '^drafts/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[^/]+$'
              then pg_catalog.split_part(p_name, '/', 2)::uuid end;
$$;
revoke all on function private.path_draft(text) from public;
grant execute on function private.path_draft(text) to authenticated, service_role;

drop policy if exists "Admins can read submission images" on storage.objects;
create policy "Members read category images" on storage.objects
  for select to authenticated
  using (bucket_id = 'submissions' and (
           (name not like 'drafts/%' and (select private.is_member()))
        or (name like 'drafts/%' and private.can_read_draft(private.path_draft(name)))));
create policy "School planners upload draft images" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'submissions' and private.can_edit_draft(private.path_draft(name)));
create policy "School planners replace draft images" on storage.objects
  for update to authenticated
  using (bucket_id = 'submissions' and private.can_edit_draft(private.path_draft(name)))
  with check (bucket_id = 'submissions' and private.can_edit_draft(private.path_draft(name)));
create policy "School planners delete draft images" on storage.objects
  for delete to authenticated
  using (bucket_id = 'submissions' and private.can_edit_draft(private.path_draft(name)));

-- Nobody calls the new trigger helpers directly.
revoke all on function private.draft_before(), private.slot_before(), private.slot_logged(),
  private.comment_before(), private.comment_logged(), private.vote_before(),
  private.submission_stamp_review(), private.submission_status_logged() from public;
