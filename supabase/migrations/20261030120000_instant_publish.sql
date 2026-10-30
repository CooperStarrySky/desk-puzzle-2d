-- Instant publishing.
--
-- GitHub runs the "Publish puzzles" job on a 10-minute timer, but it skips
-- timer runs when it's busy (on 2026-10-30 it skipped two hours). So the
-- database now starts the job itself:
--   * right away when someone presses "Publish now" (a publish_jobs row is added);
--   * within a minute of a Scheduled draft's release time (pg_cron check).
-- It calls GitHub's "run this workflow" API through pg_net, using a GitHub
-- token kept in Supabase Vault under the name 'github_publish_token'
-- (fine-grained, this repo only, Actions: Read and write). Until that secret
-- exists, everything here quietly does nothing and the 10-minute timer still works.

create schema if not exists private;

-- When we last asked GitHub to run, so the minute check doesn't ask over and over.
create table if not exists private.publisher_kicks (
  id        int primary key default 1 check (id = 1),
  kicked_at timestamptz not null
);

create or replace function private.kick_publisher()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  tok text;
begin
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then return; end if;
  if to_regclass('vault.decrypted_secrets') is null then return; end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1'
    into tok using 'github_publish_token';
  if tok is null or tok = '' then return; end if;

  insert into private.publisher_kicks (id, kicked_at) values (1, now())
    on conflict (id) do update set kicked_at = excluded.kicked_at;

  execute 'select net.http_post(url := $1, body := $2, headers := $3)'
    using 'https://api.github.com/repos/CooperStarrySky/desk-puzzle-2d/actions/workflows/publish-puzzles.yml/dispatches',
          '{"ref":"main"}'::jsonb,
          jsonb_build_object(
            'Authorization', 'Bearer ' || tok,
            'Accept', 'application/vnd.github+json',
            'X-GitHub-Api-Version', '2022-11-28',
            'User-Agent', 'pathologyconnections-publisher',
            'Content-Type', 'application/json');
exception when others then
  -- Never block a "Publish now" press: the 10-minute timer is still the backup.
  raise warning 'kick_publisher: %', sqlerrm;
end;
$$;

revoke all on function private.kick_publisher() from public, anon, authenticated;

-- "Publish now": start the job the moment the request is saved.
create or replace function private.publish_job_added()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.state = 'queued' then perform private.kick_publisher(); end if;
  return null;
end;
$$;

revoke all on function private.publish_job_added() from public, anon, authenticated;

drop trigger if exists publish_jobs_kick on public.publish_jobs;
create trigger publish_jobs_kick
  after insert on public.publish_jobs
  for each row execute function private.publish_job_added();

-- Every minute: if a Scheduled draft is due or a request is still waiting,
-- and we haven't asked GitHub in the last 5 minutes, ask again.
create or replace function private.publisher_check()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  last timestamptz;
begin
  select kicked_at into last from private.publisher_kicks where id = 1;
  if last is not null and last > now() - interval '5 minutes' then return; end if;
  if exists (select 1 from public.drafts where status = 'scheduled' and target_release <= now())
     or exists (select 1 from public.publish_jobs where state = 'queued') then
    perform private.kick_publisher();
  end if;
end;
$$;

revoke all on function private.publisher_check() from public, anon, authenticated;

do $setup$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  else
    raise warning 'pg_net is not available here: instant publishing stays off.';
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.schedule('dp-publisher-check', '* * * * *', 'select private.publisher_check()');
  else
    raise warning 'pg_cron is not available here: the release-time check is off.';
  end if;
end
$setup$;
