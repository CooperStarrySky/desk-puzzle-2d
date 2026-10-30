-- Desk Puzzle: record each player's guess sequence in the private plays table,
-- so per-category class stats can be built later (docs/08-stats-plan.md §8,
-- "which clues you grouped together on each guess, shown only as class totals").
--
-- What this adds, in plain English (all columns nullable; older rows and older
-- game versions simply leave them empty):
--   * attempts        every guess in order: the 4 clue ids put together, whether
--                     it was right, and whether it was "one away". At most 40.
--   * solve_order     the group ids in the order they were solved (at most 4).
--   * revealed_group  the group shown by the "Reveal a Category" hint, if used.
--   * hint_after      3 numbers [labels, seeds, category]: how many groups were
--                     already solved when that hint was first used (null = not
--                     used, or not known).
-- Nothing public changes: puzzle_stats keeps the same columns, and plays stays
-- unreadable with the public key (row level security and grants untouched).
-- After applying this, run tools/leak_test.mjs: every line must say PASS.

-- Clue and group ids are slugs from the published puzzle file
-- (build_puzzle.py / assemble_puzzle.py slugify, plus "-2" on clashes).
create or replace function private.dp_valid_slug(s text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select s is not null and length(s) between 1 and 96 and s ~ '^[a-z0-9][a-z0-9-]*$';
$$;

-- Shape of plays.attempts: [{"i": [4 distinct ids], "ok": bool, "one_away": bool}, ...]
-- CASE guards keep each test from running on a value of the wrong type (SQL
-- does not promise left-to-right AND), so bad input is a clean "false".
create or replace function private.dp_valid_guess(e jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when pg_catalog.jsonb_typeof(e) is distinct from 'object' then false
    when (select pg_catalog.array_agg(k order by k) from pg_catalog.jsonb_object_keys(e) as ks(k))
         is distinct from array['i', 'ok', 'one_away'] then false
    when pg_catalog.jsonb_typeof(e -> 'ok') <> 'boolean' or pg_catalog.jsonb_typeof(e -> 'one_away') <> 'boolean' then false
    -- a correct guess can't also be "one away"
    when (e ->> 'ok')::boolean and (e ->> 'one_away')::boolean then false
    when pg_catalog.jsonb_typeof(e -> 'i') <> 'array' then false
    when pg_catalog.jsonb_array_length(e -> 'i') <> 4 then false
    else (select pg_catalog.count(distinct x) = 4
                 and pg_catalog.bool_and(case when pg_catalog.jsonb_typeof(x) = 'string'
                                              then private.dp_valid_slug(x #>> '{}') else false end)
          from pg_catalog.jsonb_array_elements(e -> 'i') as xs(x))
  end;
$$;

create or replace function private.dp_valid_attempts(a jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when a is null then true
    when pg_catalog.jsonb_typeof(a) <> 'array' then false
    when pg_catalog.jsonb_array_length(a) not between 1 and 40 then false
    when pg_catalog.octet_length(a::text) > 24000 then false  -- record checks 20000 chars of compact JSON first
    else (select pg_catalog.bool_and(private.dp_valid_guess(g.e))
                 -- at most 4 correct guesses in one game
                 and pg_catalog.count(*) filter (where (g.e ->> 'ok') = 'true') <= 4
          from pg_catalog.jsonb_array_elements(a) as g(e))
  end;
$$;

create or replace function private.dp_valid_solve_order(s text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when s is null then true
    when pg_catalog.array_ndims(s) is distinct from 1 or pg_catalog.cardinality(s) not between 1 and 4 then false
    else (select pg_catalog.count(*) = pg_catalog.count(distinct x)
                 and pg_catalog.bool_and(private.dp_valid_slug(x))
          from pg_catalog.unnest(s) as u(x))
  end;
$$;

revoke all on function private.dp_valid_slug(text) from public;
revoke all on function private.dp_valid_guess(jsonb) from public;
revoke all on function private.dp_valid_attempts(jsonb) from public;
revoke all on function private.dp_valid_solve_order(text[]) from public;
-- The check constraints below call these, so the role that writes plays (the
-- record function's secret key = service_role) must be able to run them. They
-- only look at the value they are given; anon/authenticated still can't call them.
grant execute on function private.dp_valid_slug(text) to service_role;
grant execute on function private.dp_valid_guess(jsonb) to service_role;
grant execute on function private.dp_valid_attempts(jsonb) to service_role;
grant execute on function private.dp_valid_solve_order(text[]) to service_role;

alter table public.plays
  add column attempts       jsonb,
  add column solve_order    text[],
  add column revealed_group text,
  add column hint_after     smallint[];

alter table public.plays
  add constraint plays_attempts_shape check (private.dp_valid_attempts(attempts)),
  -- never more guesses listed than the play says it made
  add constraint plays_attempts_count check (case when pg_catalog.jsonb_typeof(attempts) = 'array'
    then pg_catalog.jsonb_array_length(attempts) <= guesses else true end),
  add constraint plays_solve_order_shape check (private.dp_valid_solve_order(solve_order)),
  add constraint plays_revealed_group_shape check (revealed_group is null or private.dp_valid_slug(revealed_group)),
  add constraint plays_revealed_group_hint check (revealed_group is null or hint_category),
  add constraint plays_hint_after_shape check (
    hint_after is null or (
      pg_catalog.array_ndims(hint_after) = 1
      and pg_catalog.cardinality(hint_after) = 3
      and pg_catalog.array_lower(hint_after, 1) = 1
      and (hint_after[1] is null or hint_after[1] between 0 and 3)
      and (hint_after[2] is null or hint_after[2] between 0 and 3)
      and (hint_after[3] is null or hint_after[3] between 0 and 3)
      -- a number only for a hint the play says was used
      and (hint_after[1] is null or hint_labels)
      and (hint_after[2] is null or hint_seeds)
      and (hint_after[3] is null or hint_category)));
