-- Difficulty rating: 5 options -> 4 (Very easy, Easy, Difficult, Brutal).
--
-- An even scale has no middle option to fall back on, so every rating leans
-- one way. Ratings given on the old 5-point scale (Easy, Fair, Tricky, Hard,
-- Brutal) don't map cleanly onto the new one, so they move to rating_5pt
-- (kept, not deleted) and stop counting. puzzle_stats.rating_hist now has 4 slots.

alter table public.plays add column if not exists rating_5pt smallint;

update public.plays set rating_5pt = rating, rating = null where rating is not null;

alter table public.plays drop constraint if exists plays_rating_check;
alter table public.plays add constraint plays_rating_check check (rating between 1 and 4);

alter table public.puzzle_stats alter column rating_hist set default '{0,0,0,0}';

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
      count(*) filter (where p.rating = 3)::int, count(*) filter (where p.rating = 4)::int],
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

-- Recount every puzzle so rating_hist is 4 slots everywhere.
do $recount$
declare pid text;
begin
  for pid in select puzzle_id from public.puzzle_stats loop
    perform private.refresh_puzzle_stats(pid);
  end loop;
end
$recount$;
