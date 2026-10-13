-- Desk Puzzle: a "school" on every suggestion and every draft.
--
-- Today there is one puzzle group (CMSRU), so every row gets 'cmsru' and
-- nothing else changes. Later, puzzle groups at other medical schools can
-- share one bank of categories; this column is what the workspace's Archive
-- filters on ("which school sent it in / built it").
--
-- What this does, in plain English:
--   * adds submissions.school and drafts.school, filled with 'cmsru' for every
--     old row and every new row (the default);
--   * only short lower-case codes are allowed (e.g. 'cmsru', 'rwjms');
--   * an index on each, for filtering.
-- What it does NOT do: change who can read or write anything. Admins can read
-- the new column (they can already read the whole row), but nobody can set or
-- change it from the website: the insert/update column lists granted to
-- signed-in admins are unchanged, so the default always applies. The submit
-- function (secret key) also gets the default.
--
-- Safe to apply on a live database: adding a column with a constant default
-- does not rewrite the table, and the website ignores the column until the
-- workspace code asks for it (and copes if it is missing).

alter table public.submissions
  add column school text not null default 'cmsru'
    constraint submissions_school_code check (school ~ '^[a-z0-9-]{2,24}$');

alter table public.drafts
  add column school text not null default 'cmsru'
    constraint drafts_school_code check (school ~ '^[a-z0-9-]{2,24}$');

create index submissions_school on public.submissions (school);
create index drafts_school on public.drafts (school);

comment on column public.submissions.school is 'Which school''s puzzle group received it (short code, e.g. cmsru). Set by default only.';
comment on column public.drafts.school is 'Which school''s puzzle group is building it (short code, e.g. cmsru). Set by default only.';
