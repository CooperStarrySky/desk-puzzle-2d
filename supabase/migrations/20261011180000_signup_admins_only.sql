-- Desk Puzzle: only the puzzle group can create inbox accounts.
--
-- What this sets up, in plain English:
--   * private.hook_signup_admins_only  a "Before User Created" auth hook.
--     Supabase Auth calls it every time someone tries to make a new account.
--     If the email (capital letters ignored) is on public.admins, the account
--     is created. If not, sign-up is refused with the message
--     "This inbox is only for the CMSRU puzzle group." and no account exists.
--   * The minimum permissions Supabase Auth needs to run it: it may call this
--     one function and read the email column of public.admins. Nobody using
--     the website's public key can call the function.
--
-- IMPORTANT: creating the function does not switch it on. After applying this,
-- open the dashboard: Authentication -> Hooks -> Before User Created ->
-- Postgres function -> schema "private" -> hook_signup_admins_only -> Save.
--
-- Hook format (Supabase docs, "Before User Created Hook"): the function takes one
-- jsonb argument, the event, with the new user under event->'user'. Returning
-- '{}' lets sign-up continue; returning {"error": {"http_code", "message"}}
-- refuses it and the message is shown to the person signing up.

-- "private" already exists (submissions migration) and is not exposed through
-- the website API, so the browser can never call this function directly.
create schema if not exists private;

create or replace function private.hook_signup_admins_only(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  new_email text := lower(trim(coalesce(event -> 'user' ->> 'email', '')));
begin
  -- On the list: let the account be created.
  if new_email <> '' and exists (
    select 1 from public.admins a where lower(a.email) = new_email
  ) then
    return '{}'::jsonb;
  end if;

  -- Not on the list (or no email at all, e.g. a phone sign-up): refuse.
  return jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message', 'This inbox is only for the CMSRU puzzle group.'
    )
  );
end;
$$;

-- Only Supabase Auth may run the hook.
revoke all on function private.hook_signup_admins_only(jsonb) from public, anon, authenticated;
grant usage on schema private to supabase_auth_admin;
grant execute on function private.hook_signup_admins_only(jsonb) to supabase_auth_admin;

-- Supabase Auth runs the hook as its own role (supabase_auth_admin), which has
-- no access to our tables by default. Give it read access to the email column
-- of admins only, and a row rule so it can see those rows (row level security
-- is on for admins). It cannot change the list.
grant usage on schema public to supabase_auth_admin;
grant select (email) on table public.admins to supabase_auth_admin;

create policy "Auth can check the admins list at sign-up"
  on public.admins for select to supabase_auth_admin
  using (true);
