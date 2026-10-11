-- Desk Puzzle: anonymous play stats (docs/08-stats-plan.md in the platform repo).
--
-- What this sets up, in plain English:
--   * plays         one private row per browser per puzzle: how that game ended.
--                   Written only by the "record" server function. Nobody with
--                   the public key can read it.
--   * record_rate   the "record" function's rate-limit log (salted IP hashes).
--   * puzzle_stats  public totals per puzzle (counts only, no browser ids). A
--                   trigger keeps it current whenever plays changes.
--   * an hourly clean-up that deletes rate-limit rows (record_rate AND the
--     older submit_rate) after 24 hours, as the privacy notice promises.
-- After applying this, run tools/leak_test.mjs: every line must say PASS.

-- ── Private rows: one per browser per puzzle ────────────────────────────────
create table public.plays (
  puzzle_id     text not null check (puzzle_id ~ '^[a-z0-9-]+-[0-9]{4}-[0-9]{2}-[0-9]{2}$' and length(puzzle_id) <= 120),
  anon_id       uuid not null,                 -- random id the browser made; not linked to a person
  finished_at   timestamptz not null default now(),
  outcome       text not null check (outcome in ('won', 'lost')),
  mistakes      smallint not null check (mistakes between 0 and 20),
  guesses       smallint not null check (guesses between 0 and 40),
  hint_labels   boolean not null default false,
  hint_seeds    boolean not null default false,
  hint_category boolean not null default false,
  casual        boolean not null default false,
  rating        smallint check (rating between 1 and 5),
  rated_at      timestamptz,
  primary key (puzzle_id, anon_id)               -- the "counted once" rule
);

-- ── Rate-limit log for "record" (IP stored only as a salted hash) ──────────
create table public.record_rate (
  ip_hash text not null,
  at      timestamptz not null default now()
);
create index record_rate_ip_at on public.record_rate (ip_hash, at);

-- ── Public totals ───────────────────────────────────────────────────────────
-- Definitions (all from plays rows for this puzzle):
--   plays          every finish, casual games included
--   std_finishes   finishes where casual mode was never on ("standard")
--   std_wins       standard finishes that were solved
--   mistakes_hist  5 slots: [0] [1] [2] [3] = standard WINS with 0, 1, 2, 3
--                  mistakes; [4] = standard LOSSES (out of mistakes). The
--                  slots add up to std_finishes. (A standard game is lost on
--                  the 4th mistake, so a win never has more than 3.)
--   hint_any       standard finishes that used at least one hint
--   hint_labels / hint_seeds / hint_category  standard finishes using that hint
--   rating_n       finishes with a difficulty rating (casual included)
--   rating_hist    5 slots: how many rated 1 (Easy) .. 5 (Brutal)
create table public.puzzle_stats (
  puzzle_id     text primary key,
  plays         integer not null default 0,
  std_finishes  integer not null default 0,
  std_wins      integer not null default 0,
  mistakes_hist integer[] not null default '{0,0,0,0,0}',
  hint_any      integer not null default 0,
  hint_labels   integer not null default 0,
  hint_seeds    integer not null default 0,
  hint_category integer not null default 0,
  rating_n      integer not null default 0,
  rating_hist   integer[] not null default '{0,0,0,0,0}',
  updated_at    timestamptz not null default now()
);

-- ── Keep the totals current ─────────────────────────────────────────────────
-- Recounts the one puzzle from scratch each time (a class is a few hundred
-- rows at most), so the totals can never drift. The advisory lock makes two
-- players finishing at the same moment take turns instead of both writing
-- totals that miss the other's row.
create or replace function private.refresh_puzzle_stats(p_puzzle_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('puzzle_stats:' || p_puzzle_id));
  insert into public.puzzle_stats as s (
    puzzle_id, plays, std_finishes, std_wins, mistakes_hist,
    hint_any, hint_labels, hint_seeds, hint_category, rating_n, rating_hist, updated_at)
  select p_puzzle_id,
    count(*)::int,
    count(*) filter (where not p.casual)::int,
    count(*) filter (where not p.casual and p.outcome = 'won')::int,
    array[
      count(*) filter (where not p.casual and p.outcome = 'won' and p.mistakes = 0)::int,
      count(*) filter (where not p.casual and p.outcome = 'won' and p.mistakes = 1)::int,
      count(*) filter (where not p.casual and p.outcome = 'won' and p.mistakes = 2)::int,
      count(*) filter (where not p.casual and p.outcome = 'won' and p.mistakes >= 3)::int,
      count(*) filter (where not p.casual and p.outcome = 'lost')::int],
    count(*) filter (where not p.casual and (p.hint_labels or p.hint_seeds or p.hint_category))::int,
    count(*) filter (where not p.casual and p.hint_labels)::int,
    count(*) filter (where not p.casual and p.hint_seeds)::int,
    count(*) filter (where not p.casual and p.hint_category)::int,
    count(p.rating)::int,
    array[
      count(*) filter (where p.rating = 1)::int, count(*) filter (where p.rating = 2)::int,
      count(*) filter (where p.rating = 3)::int, count(*) filter (where p.rating = 4)::int,
      count(*) filter (where p.rating = 5)::int],
    pg_catalog.now()
  from public.plays p
  where p.puzzle_id = p_puzzle_id
  on conflict (puzzle_id) do update set
    plays = excluded.plays, std_finishes = excluded.std_finishes, std_wins = excluded.std_wins,
    mistakes_hist = excluded.mistakes_hist, hint_any = excluded.hint_any,
    hint_labels = excluded.hint_labels, hint_seeds = excluded.hint_seeds,
    hint_category = excluded.hint_category, rating_n = excluded.rating_n,
    rating_hist = excluded.rating_hist, updated_at = excluded.updated_at;
end;
$$;

create or replace function private.plays_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform private.refresh_puzzle_stats(old.puzzle_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and (tg_op = 'INSERT' or new.puzzle_id is distinct from old.puzzle_id) then
    perform private.refresh_puzzle_stats(new.puzzle_id);
  end if;
  return null;
end;
$$;

create trigger plays_keep_totals
  after insert or update or delete on public.plays
  for each row execute function private.plays_changed();

-- ── 24-hour clean-up of the rate-limit logs ─────────────────────────────────
create or replace function private.purge_rate_logs()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.record_rate where at < pg_catalog.now() - interval '24 hours';
  delete from public.submit_rate where at < pg_catalog.now() - interval '24 hours';
$$;

revoke all on function private.refresh_puzzle_stats(text) from public;
revoke all on function private.plays_changed() from public;
revoke all on function private.purge_rate_logs() from public;

-- ── Lock everything down ────────────────────────────────────────────────────
alter table public.plays        enable row level security;
alter table public.record_rate  enable row level security;
alter table public.puzzle_stats enable row level security;

revoke all on table public.plays, public.record_rate, public.puzzle_stats from anon, authenticated;
-- The public may read the totals and nothing else (no rule = no rows for plays
-- and record_rate; only the server function's secret key touches them).
grant select on table public.puzzle_stats to anon, authenticated;
create policy "Anyone can read puzzle totals"
  on public.puzzle_stats for select to anon, authenticated
  using (true);

-- ── Hourly clean-up job (pg_cron) ───────────────────────────────────────────
-- Supabase lets a migration turn pg_cron on. If this database does not offer
-- it, the migration still applies and prints a warning; then turn it on in the
-- dashboard (Integrations → Cron) and run the two lines inside this block in
-- the SQL editor (supabase/SETUP.md, "Play stats"). The record and submit
-- functions also delete old rate rows every time they run.
do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.schedule('dp-purge-rate-logs', '17 * * * *', 'select private.purge_rate_logs()');
  else
    raise warning 'pg_cron is not available here: schedule private.purge_rate_logs() hourly by hand (supabase/SETUP.md).';
  end if;
end
$cron$;
