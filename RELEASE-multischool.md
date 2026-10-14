# Multischool release: ordered steps

Branch `feature/multischool` (stages S1-S4) goes live in one sitting, in this
order. Each step says how to check it worked and how to undo it. Do them one at
a time and stop at the first surprise.

Why this order:

- **Database first.** The new screens need the new tables and functions. The
  old submit function keeps working on the new database: `submissions.school`
  defaults to `cmsru` (from `20261012120000_school.sql`), so students' category
  sends still land. Only two things break in the gap: the old inbox's Shortlist
  and Decline buttons, and any full puzzle sent from an old Studio (the database
  now refuses those). Keep the gap short.
- **Site before function.** The old function ignores `school`, so the new Studio
  (which sends it) works with the old function. The new function requires
  `school`, so deploying it first would reject every send from the old Studio
  still cached in students' browsers until the new site is live.

## 0. Pre-checks

1. In the site repo: `git fetch origin`, then
   `git rev-parse --short origin/main` must print `aee9ed0`
   (the base of `feature/multischool`). If main has moved (Codex also commits),
   rebase first: `git checkout feature/multischool && git rebase origin/main`,
   fix any conflicts, and run the full test battery again (step 0.4).
2. `git status` on `feature/multischool` is clean apart from the known
   untracked files (`.DS_Store`, `docs/mockups/`, `puzzles/_spec/*.yaml` and
   other untracked puzzle folders, `supabase/.temp/`). None of those get committed.
3. Supabase MCP `list_migrations`: `20261012120000_school` (or the matching
   `school` entry) must already be applied. If it is not, apply that file first
   with `apply_migration`, exactly like step 1.
4. Full test battery passes (no Supabase needed):
   ```
   npm install --no-save @electric-sql/pglite   # or set PGLITE_MODULE
   for f in supabase/tests/*.test.mjs supabase/tests/multischool_checks*.mjs; do node "$f" || echo "FAILED $f"; done
   node tools/stats_test.mjs; node tools/publish_spec_test.mjs; node tools/publish_drafts_test.mjs
   node supabase/tests/ui/run_all.mjs
   ```
5. Backup. Free projects have no point-in-time restore, and step 1 cannot be
   undone by a script (shortlisted rows become New, declined rows move to the
   Trash). Take a copy first, from the site folder:
   ```
   npx supabase db dump -f ~/dp-backup-schema-$(date +%F).sql
   npx supabase db dump --data-only -f ~/dp-backup-data-$(date +%F).sql
   ```
   (`db dump` may need Docker. If it can't run, use the dashboard's Database >
   Backups if the plan has them, or at least export `submissions`,
   `review_events`, `drafts`, `draft_slots`, `admins` as CSV from the Table editor.)
   Keep the files outside the repo (the repo is public).
6. Pause the automatic publisher for the gap (the copy on main is the old one
   and was never tested against the new schema):
   `gh workflow disable publish-puzzles.yml`. Don't schedule a release inside
   the next hour. Turned back on in step 4.

## 1. Apply the migration

- Supabase MCP `apply_migration`, name `multischool`, query = the whole of
  `supabase/migrations/20261013120000_multischool.sql`. It runs as one
  transaction: if any statement fails, nothing is applied.
- Check: `list_migrations` shows it. Then in the SQL editor:
  ```
  select slug, name, status from public.schools;            -- cmsru, active
  select count(*) from public.members;                      -- = old admins count
  select status, count(*) from public.submissions group by 1; -- only new / used / trashed
  ```
- Note: `apply_migration` records its own version number. If it differs from
  `20261013120000`, never run `npx supabase db push` for this file later; first
  mark it applied with `npx supabase migration repair --status applied 20261013120000`.
- Rollback: if it failed, nothing changed; fix and retry. If it succeeded and
  something is badly wrong, restore from the step 0.5 backup (ask Thirth first;
  this overwrites data).

## 2. Site owner, and Thirth as CMSRU lead

The migration adds no site owner. In the SQL editor, first see who is there and
pick Thirth's exact sign-in email:

```
select email, school, role, display_name, active from public.members order by school, role, email;
```

Then (replace `<THIRTH_EMAIL>` in all three places):

```
insert into public.site_owners (email) values (lower('<THIRTH_EMAIL>')) on conflict do nothing;
update public.members set role = 'lead' where school = 'cmsru' and email = lower('<THIRTH_EMAIL>');
-- only if the update said "0 rows" (he was not on the old admins list):
-- insert into public.members (email, school, role, added_by) values (lower('<THIRTH_EMAIL>'), 'cmsru', 'lead', 'release');
```

- Check: `select * from public.site_owners;` shows one row, and the members query
  shows him as `lead` at `cmsru`.
- Rollback: `delete from public.site_owners where email = lower('<THIRTH_EMAIL>');`
  and set his role back with the same `update ... set role = 'admin'` (ask first:
  it removes owner access).

## 3. Import the categories of puzzles already live

From the site folder:

```
node tools/import_published_categories.mjs                     # dry run: read the list
node tools/import_published_categories.mjs --sql ~/dp-import.sql
```

Paste `~/dp-import.sql` into the SQL editor and run it. Running it twice changes
nothing the second time.

- Check: `select count(*) from public.submissions where source = 'published';` and
  `select count(*) from public.category_uses;` roughly match the dry-run list.
- Rollback (deletes rows, ask Thirth first): remove the rows it added,
  `delete from public.category_uses where submission_id in (select id from public.submissions where source = 'published');`
  then `delete from public.submissions where source = 'published';`. Uses it
  attached to existing student suggestions stay; they are harmless history.

## 4. Merge to main, push, build Pages

```
git checkout main
git pull --ff-only origin main            # must still be at aee9ed0 (or the rebased base)
git merge --no-ff feature/multischool -m "Multischool release (S1-S4)"
git push origin main
gh api -X POST repos/cooperstarrysky/desk-puzzle-2d/pages/builds
gh workflow enable publish-puzzles.yml
```

- Check: `gh api repos/cooperstarrysky/desk-puzzle-2d/pages/builds/latest --jq .status`
  says `built`; then open https://pathologyconnections.org/inbox/ and
  https://pathologyconnections.org/studio/?submit with a hard reload (the
  Studio shows "Your school").
- Rollback: `git revert -m 1 <merge commit>`, push, request a Pages build
  again. The database stays on the new schema; the old inbox's Shortlist and
  Decline buttons will not work against it, but reading does. Disable the
  publisher again (`gh workflow disable publish-puzzles.yml`) while main is
  back on the old code.

## 5. Deploy the submit function

From the site folder, on `main` after step 4:

```
npx supabase functions deploy submit --no-verify-jwt --use-api
```

- Check: step 6's `--send-sample=puzzle` line.
- Rollback: deploy the old code from a scratch worktree:
  ```
  git worktree add /tmp/dp-old aee9ed0
  cd /tmp/dp-old && npx supabase functions deploy submit --no-verify-jwt --use-api
  ```
  (then `git worktree remove /tmp/dp-old` from the site folder). The old function
  still works on the new database (step 1 note).

## 6. Post-release checks

1. Leak test against the live project, from the site folder:
   `node tools/leak_test.mjs` then `node tools/leak_test.mjs --send-sample=puzzle`.
   Every line must say PASS (the second also proves full puzzles and sends
   with no school are refused). Move the test category to the Trash.
2. Sign-in smoke: Thirth signs in at /inbox/. Header says "All schools", the
   Admin tab is there, the people table lists the old admins as CMSRU admins,
   and ⚙ Settings opens. One old admin signs in and sees no Admin tab.
3. Studio submit smoke: from a private window, /studio/?submit, pick
   Cooper Medical School of Rowan University, send a small test category, get a
   receipt. It shows in the Category database with school CMSRU. Trash it.
4. Publisher dry run: `gh workflow run publish-puzzles.yml -f dry_run=true`,
   then `gh run watch`. It must finish green and push only a
   `publish-dry-run/...` branch (delete that branch afterwards, with Thirth's OK).
5. Watch the next real scheduled publish once (Actions tab) before calling the
   release done.

If any check fails: stop, note the exact error, and use that step's rollback.
