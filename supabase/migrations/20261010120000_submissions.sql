-- Desk Puzzle: private inbox for category submissions.
--
-- What this sets up, in plain English:
--   * submissions  one row per category a student sends in. Holds puzzle answers
--                  and maybe a private email, so nobody outside the puzzle group
--                  can read it.
--   * admins       the puzzle group's email addresses. Only people on this list
--                  can read or review submissions.
--   * submit_rate  a tiny log the "submit" function uses to stop one computer
--                  sending more than a few submissions an hour.
--   * a private file bucket "submissions" for the clue images.
--
-- Students never touch these tables. The page's public key can only call the
-- "submit" server function, which uses the secret service key to write here.
-- After applying this, run tools/leak_test.mjs: every line must say PASS.

-- ── Who counts as an admin ───────────────────────────────────────────────────
-- A small helper that answers "is the signed-in person on the admins list?".
-- It lives in a "private" schema so the website API can't call it directly, and
-- it runs with the owner's rights so the admins table can check itself without
-- looping forever (a rule on a table that reads the same table would recurse).
create schema if not exists private;

create table public.admins (
  email    text primary key,
  added_at timestamptz not null default now()
);

create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.admins a
    where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

revoke all on function private.is_admin() from public;
grant usage on schema private to authenticated;
grant execute on function private.is_admin() to authenticated;

-- ── Submissions ─────────────────────────────────────────────────────────────
create table public.submissions (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  kind           text not null default 'category' check (kind in ('category', 'puzzle')),
  status         text not null default 'new' check (status in ('new', 'shortlisted', 'used', 'declined')),
  suggested_tier int check (suggested_tier between 1 and 4),
  group_name     text not null,            -- the category name, for the inbox list
  payload        jsonb not null,           -- the group; images are file paths in the private bucket
  credit_mode    text not null check (credit_mode in ('named', 'anonymous')),
  credit_name    text,
  credit_line    text,
  contact_email  text,                     -- private; never published
  consent        boolean not null check (consent),
  admin_note     text,
  used_in        text,                     -- puzzle id once it ships
  receipt_code   text not null unique,     -- the "DP-XXXX-XXXX" code the student keeps
  reviewed_by    text,
  reviewed_at    timestamptz
);

create index submissions_status_created on public.submissions (status, created_at desc);

-- ── Rate limit log (one row per send attempt, IP stored only as a salted hash)
create table public.submit_rate (
  ip_hash text not null,
  at      timestamptz not null default now()
);

create index submit_rate_ip_at on public.submit_rate (ip_hash, at);

-- ── Lock everything down ────────────────────────────────────────────────────
-- Row-level security on: with no rule that lets someone in, they see nothing.
alter table public.submissions enable row level security;
alter table public.admins      enable row level security;
alter table public.submit_rate enable row level security;

-- Belt and braces: take away the default table rights Supabase hands out, so
-- the anonymous (public) key is refused even before row rules are checked.
revoke all on table public.submissions, public.admins, public.submit_rate from anon, authenticated;

-- Signed-in people may ask to read submissions and change only the review
-- fields. The row rules below then limit that to the admins list.
grant select on table public.submissions to authenticated;
grant update (status, admin_note, used_in, reviewed_by, reviewed_at) on table public.submissions to authenticated;
grant select on table public.admins to authenticated;

create policy "Admins can read submissions"
  on public.submissions for select to authenticated
  using (private.is_admin());

create policy "Admins can review submissions"
  on public.submissions for update to authenticated
  using (private.is_admin())
  with check (private.is_admin());

-- Admins can see the admins list, which is how the inbox checks "am I in?".
create policy "Admins can see the admins list"
  on public.admins for select to authenticated
  using (private.is_admin());

-- No delete rule on purpose: declined submissions stay as a record. To really
-- remove one, use the Supabase dashboard (Table editor).
-- No rules at all for submit_rate: only the server function touches it.

-- ── Private image bucket ────────────────────────────────────────────────────
-- Not public, 700 KB per file, images only. The server function uploads with
-- the service key; admins read through short-lived signed links.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('submissions', 'submissions', false, 716800, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

create policy "Admins can read submission images"
  on storage.objects for select to authenticated
  using (bucket_id = 'submissions' and private.is_admin());
-- Nothing for the anonymous key, and no insert/update/delete rules for anyone:
-- uploads and clean-up happen only in the server function.
