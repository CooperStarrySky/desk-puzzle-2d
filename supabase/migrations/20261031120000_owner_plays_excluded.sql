-- Leave the site owner's own games out of the public class stats.
--
-- Plays are anonymous (a random id per browser), so the workspace tells us
-- which browsers are the owner's: signing in there as the site owner calls
-- mark_owner_browser(<that browser's game id>). Every play from a marked
-- browser, past and future, is left out of puzzle_stats. The plays rows stay.

create table if not exists private.owner_browsers (
  anon_id  uuid primary key,
  email    text not null,
  added_at timestamptz not null default now()
);

create or replace function public.mark_owner_browser(p_anon uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare pid text;
begin
  if not private.is_site_owner() then raise exception 'Only the site owner can do this.'; end if;
  if p_anon is null then return; end if;
  insert into private.owner_browsers (anon_id, email) values (p_anon, private.my_email())
    on conflict (anon_id) do nothing;
  if not found then return; end if;
  for pid in select distinct puzzle_id from public.plays where anon_id = p_anon loop
    perform private.refresh_puzzle_stats(pid);
  end loop;
end;
$$;

revoke all on function public.mark_owner_browser(uuid) from public, anon;
grant execute on function public.mark_owner_browser(uuid) to authenticated;

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
    and not exists (select 1 from private.owner_browsers o where o.anon_id = p.anon_id)
  on conflict (puzzle_id) do update set
    plays = excluded.plays, std_finishes = excluded.std_finishes, std_wins = excluded.std_wins,
    mistakes_hist = excluded.mistakes_hist, hint_any = excluded.hint_any,
    hint_labels = excluded.hint_labels, hint_seeds = excluded.hint_seeds,
    hint_category = excluded.hint_category, rating_n = excluded.rating_n,
    rating_hist = excluded.rating_hist, updated_at = excluded.updated_at;
end;
$$;
