# Setting up the submissions inbox

This connects the Puzzle Studio's "Send to the puzzle group" button to a private
inbox on Supabase (a hosted database with file storage and sign-in). Until you do
this, the Studio keeps working the old way: students download a file and send it in.

Plan on about 45 minutes the first time. You only do it once.

**Three things are secret and never go in this repo, in `studio/config.js`, or in a
chat:** the database password, the secret key (starts with `sb_secret_`), and the
Turnstile secret key. Keep them in your password manager. Everything else below is
public by design.

## 1. Make the Supabase project

1. Go to <https://supabase.com>, sign up (GitHub sign-in is fine), and click **New project**.
2. Name it `desk-puzzle`. Region: **East US (North Virginia)**.
3. It asks for a database password. Click **Generate a password**, then save it in your
   password manager right away. You need it once, in step 3.
4. Wait a minute or two while it builds.

## 2. Put the two public values in `studio/config.js`

1. Click **Connect** at the top of the dashboard (or go to **Project Settings → Data API**)
   and copy the **Project URL**. It looks like `https://abcdefghijklmnop.supabase.co`.
2. Go to **Project Settings → API Keys → API Keys tab** and copy the **Publishable key**
   (starts with `sb_publishable_`). Do **not** copy the secret key.
3. Open `studio/config.js` and paste them between the quotes:

   ```js
   supabaseUrl: 'https://abcdefghijklmnop.supabase.co',
   supabasePublishableKey: 'sb_publishable_...',
   ```

4. While you're there, set `submitTo` to the group's email or GroupMe link. Students see
   it if sending ever fails and they download a copy instead.

Don't commit or publish yet. Do the safety check in step 7 first.

## 3. Accounts: passwords, 6-digit codes, and who may sign up

The puzzle group signs in with **email + password**. Making an account and resetting a
password are confirmed with a **6-digit code** typed into the inbox page. The emails
never contain a link, because Rowan's email scanner (Microsoft Safe Links) opens links
before you do and uses them up.

**a. Email settings.** Dashboard → **Authentication → Sign In / Providers → Email**:

- **Enable Email provider:** on
- **Confirm email:** on
- **Minimum password length:** 8
- And under **Authentication → Sign In / Providers** (user sign-ups): **Allow new users to sign up:** on.
  Only emails on the admins list get through, thanks to step c.

**b. Email templates (codes only).** Dashboard → **Authentication → Emails → Templates**.
Replace the body of **Confirm sign up** and **Reset password** with the code-only versions
below, and click **Save** on each. Never put `{{ .ConfirmationURL }}` back in.

Confirm sign up:

```html
<h2>Your Desk Puzzle inbox code</h2>
<p>Your code is <strong>{{ .Token }}</strong></p>
<p>Type it on the inbox page to finish making your account.</p>
```

Reset password:

```html
<h2>Reset your Desk Puzzle inbox password</h2>
<p>Your code is <strong>{{ .Token }}</strong></p>
<p>Type it on the inbox page, then choose a new password.</p>
```

**c. Only the puzzle group can sign up.** The migration
`supabase/migrations/20261011180000_signup_admins_only.sql` (applied in step 5) adds a
check that refuses any new account whose email isn't on the admins list. Once step 5 has
created it, switch it on:
dashboard → **Authentication → Hooks** → **Before User Created** → choose
**Postgres function** → schema `private` → function `hook_signup_admins_only` → **Save**.
Test it: in the inbox, choose **Create account** with an email that isn't on the list. It
should say "This inbox is only for the CMSRU puzzle group."

**d. Site URL.** Dashboard → **Authentication → URL Configuration** → **Site URL:**
`https://pathologyconnections.org/`. (No sign-in links are sent any more, so the
redirect list doesn't matter for the inbox.)

**Already used the inbox with emailed codes before passwords?** Your account still
exists. Open the inbox, choose **Forgot password** once, and set a password.

## 4. Install the Supabase command-line tool

This is a small program (about 100 MB) that sends the database setup and the server
function to your project. It does not need Docker. Open Terminal and run:

```bash
brew install supabase/tap/supabase
```

Then sign in (a browser window opens; approve it):

```bash
supabase login
```

## 5. Connect this folder to your project and create the tables

Go to the site folder:

```bash
cd ~/Downloads/"Claude Projects"/Desk-Puzzle-2D-site
```

Link it. Your project ref is the `abcdefghijklmnop` part of the Project URL. It asks for
the database password from step 1:

```bash
supabase link --project-ref abcdefghijklmnop
```

Create the tables, the safety rules, and the private image folder:

```bash
supabase db push
```

It lists one file, `20261010120000_submissions.sql`, and asks to confirm. Say yes.

## 6. Put the submit function online

Upload the server function that receives categories:

```bash
supabase functions deploy submit --no-verify-jwt
```

`--no-verify-jwt` is required: students aren't signed in, and publishable keys aren't
login tokens. The function checks the website, the hourly limit, and the content itself.
If the command complains about Docker, run it again with `--use-api` on the end.

**You don't need to give the function a key.** Supabase hands every function your
project's secret keys automatically (as `SUPABASE_SECRET_KEYS`), and the function picks
one up on its own. Only if the safety check in step 7 says sending failed with a
"server key" error: open **Edge Functions → Secrets → Add new secret** in the
dashboard, name it `DP_SECRET_KEY`, and paste your secret key (starts with `sb_secret_`).
Use the dashboard, not Terminal, so the key doesn't end up in your Terminal history.

## 7. Run the safety check (must be all PASS)

This pretends to be a stranger who copied the publishable key from the website and
tries to read, change, or add submissions, admins, and images:

```bash
node tools/leak_test.mjs
```

Every line must say **PASS**. If any line says FAIL, stop, don't publish, and ask for
help. Then send one test category through the real function:

```bash
node tools/leak_test.mjs --send-sample
```

It prints a receipt code like `DP-7KQM-2XRF`. You'll decline that test category in step 9.

Run `node tools/leak_test.mjs` again after **any** future database change.

## 8. Add the puzzle group as admins

In the dashboard, open **SQL Editor**, paste this with the real emails, and click **Run**:

```sql
insert into admins (email) values ('you@rowan.edu'), ('friend@rowan.edu');
```

Capital letters don't matter. To remove someone later:

```sql
delete from admins where email = 'friend@rowan.edu';
```

## 9. Try the inbox, then publish

1. Commit the filled-in `studio/config.js` and publish the site as usual.
2. Make sure your email is on the admins list (step 8) and the sign-up check is
   switched on (step 3c). Open `https://pathologyconnections.org/inbox`, choose
   **Create account**, pick a password, and type the 6-digit code from the email.
3. You should see the test category. Open it, click **Decline**, and add the note "test".
4. Send a real one from `studio/?submit` on your phone and check that it shows up.

## Optional: the "are you human" check (Cloudflare Turnstile)

Turn this on if spam ever shows up. It's free.

1. Make a free Cloudflare account at <https://dash.cloudflare.com>, open **Turnstile**,
   and click **Add widget**. Hostnames: `pathologyconnections.org` and `localhost`.
   Mode: **Managed**.
2. Paste the **Site Key** (public, starts with `0x`) into `turnstileSiteKey` in `studio/config.js`.
3. Store the **Secret Key** in Supabase (dashboard **Edge Functions → Secrets**, name
   `TURNSTILE_SECRET`), or in Terminal:

   ```bash
   supabase secrets set TURNSTILE_SECRET=paste_the_secret_key_here
   ```

Once the secret is set, `--send-sample` gets refused for missing the check. That's
expected and correct. Test by sending from the Studio instead.

## Good to know

- **Free projects pause after about a week with no activity.** While paused, sending
  fails and students get the "download a copy instead" option. Open the dashboard
  and click **Restore**. Regular use keeps it awake.
- **Code emails are rate-limited.** Supabase's built-in email sender only sends a few
  emails an hour, and one per person per minute. That's fine for a handful of admins.
  Day to day nobody needs an email: sign-in is just email + password. If a code doesn't
  arrive, check Junk, wait a minute, and press **Resend code**.
- **Adding someone to the group:** add their email to the admins list (step 8) first,
  then they choose **Create account** in the inbox. Removing them from the list locks
  them out of all submissions straight away.
- **The inbox address is unlisted:** `inbox/` (pathologyconnections.org/inbox). Nothing on the site
  links to it, and search engines are told not to index it. Bookmark it. (Only people
  on the admins list can read anything there anyway.)
- **Hourly limits:** 5 sends per browser and 40 per internet connection (a whole class
  on campus wifi shares one connection).
- **Size limits:** a category can have up to 8 images (about 7 MB in total); a full
  puzzle up to 16 images (about 9 MB). Each image is at most 700 KB. The Studio warns
  before sending if something's too big. The exact file format is in
  `supabase/SUBMISSION_FORMAT.md`.
- **Full puzzles:** students can send a whole puzzle (4 categories with tiers, no date).
  It shows in the inbox tagged "Full puzzle". **Download for import**, then
  `tools/import_submission.py` turns it into a complete spec; set the date in it and
  run `tools/build_puzzle.py`.
- **Getting categories into a puzzle:** in the inbox, open a category and click
  **Download for import**, or click **Download all shortlisted**. Then carry on with
  `tools/import_submission.py` as described in the README ("Category submissions").
- **After changing the server function** (for example, this update that added full
  puzzles), send the new version to Supabase from the site folder:
  `npx supabase functions deploy submit --no-verify-jwt --use-api`. Then run
  `node tools/leak_test.mjs --send-sample=puzzle` and decline the two test entries.
- **Deleting a submission:** the inbox can't delete, on purpose (declined ones stay as
  a record). To really delete one, use the dashboard's **Table Editor**.

## Play stats (class totals on the results screen)

The game sends anonymous results for puzzles released **after Oct 11, 2026** to a
second server function, `record`, and shows class totals ("How everyone did", the
difficulty rating, and a line on each menu card) once 10 players have finished. What
is sent is exactly the list in the game's Settings dialog. Nothing works until you do
these steps; until then the game simply shows no class totals.

Run these from the site folder (`Desk-Puzzle-2D-site`), the same way as steps 5-7:

1. **Create the tables** (`plays`, `puzzle_stats`, `record_rate`, plus the hourly clean-up):

   ```
   npx supabase db push
   ```

   It should list `20261011120000_play_stats.sql`. If it prints a warning that
   `pg_cron is not available`, do step 4.

2. **Put the record function online:**

   ```
   npx supabase functions deploy record --no-verify-jwt --use-api
   ```

   It uses the same secret key you already set for `submit` (`DP_SECRET_KEY`).

3. **Run the safety check** (every line must say PASS):

   ```
   node tools/leak_test.mjs
   node tools/leak_test.mjs --send-sample=stats
   ```

   The second one sends one fake finish for a puzzle called `leak-test-<tomorrow>` and
   checks it reaches the totals but not as a readable row. Then remove it: dashboard
   → **SQL Editor** → paste and run (in this order):

   ```
   delete from public.plays where puzzle_id like 'leak-test-%';
   delete from public.puzzle_stats where puzzle_id like 'leak-test-%';
   ```

4. **Check the hourly clean-up job.** The privacy note promises the scrambled network
   address is deleted after 24 hours. The migration turns on `pg_cron` and schedules
   a job called `dp-purge-rate-logs` (it also clears the older `submit_rate` log).
   To check: dashboard → **Integrations** → **Cron** → **Jobs**. You should see
   `dp-purge-rate-logs` running `select private.purge_rate_logs()` at minute 17 of
   every hour. If the job is missing:
   - **Integrations** → **Cron** → **Enable pg_cron** (or **Database** →
     **Extensions** → search `pg_cron` → turn it on), then
   - **SQL Editor** → run:

     ```
     select cron.schedule('dp-purge-rate-logs', '17 * * * *', 'select private.purge_rate_logs()');
     ```

   Both functions also delete old rows every time they run, so the job is a backstop
   for quiet weeks.

Good to know:
- **Limits:** 300 stats events per hour per internet connection (a whole class can
  share one campus connection). One finish per browser per puzzle; later finishes of
  the same puzzle are ignored. A rating can be changed.
- **Totals only:** the public key can read `puzzle_stats` (counts per puzzle) and
  nothing else. `plays` rows have no names, emails, or IP addresses, only a random
  per-browser id.
- **If the project is paused** (free tier, long breaks), the game quietly hides the
  totals and keeps unsent results for up to 3 days. Restore the project in the dashboard.

## Workspace (puzzle group planning)

The inbox is growing into a shared workspace for the puzzle group. Its data lives in
`supabase/migrations/20261011200000_workspace.sql`. Only people on the admins list
can see any of it; the public key gets nothing.

What each piece holds:

- **admins** now also has a `display_name` and `color` for each person (used for
  avatars and "Shortlisted by John D."). Each admin can change only their own.
- **submissions** gains `tags` (block or system labels like "Cardio") and a hidden
  search column, so the inbox can find a suggestion by its name, explanation, clue
  labels, or clue notes. This works for single categories and full puzzles.
- **review_events** is the history of each suggestion: sent in, shortlisted,
  declined, reopened, used, commented on, voted for, added to or removed from a
  draft, published. The database writes these lines itself, using the signed-in
  email, so nobody can skip or fake "who did it". Older suggestions get a "sent in"
  line plus their last known review.
- **comments** are notes on a suggestion or a draft. Everyone reads them; you can
  edit or delete only your own.
- **votes** is one thumbs-up per person per suggestion.
- **drafts** are puzzles being planned. Status goes Planning, Ready, Scheduled,
  Published. Ready and Scheduled need all 4 slots filled; Scheduled also needs a
  release time. Only the publishing job (secret key) can mark a draft Published, and
  after that the draft is frozen.
- **draft_slots** are the 4 tier slots of a draft. A slot holds a suggestion (or one
  group of a full-puzzle suggestion) or a group typed in by hand. A suggestion may
  sit in two drafts at once.
- **draft_events** is the history of each draft (made, renamed, scheduled, lost a
  category, published), and **activity** merges both histories for the team feed.
- **publish_jobs** holds "Publish now" requests and scheduled runs for the publishing
  job (see "Automatic publishing" below).

When a draft is published, the database marks its suggestions Used, takes them out of
every other draft, puts any Scheduled draft that lost one back to Ready and any Ready
draft back to Planning, and tells that draft's owner in the feed. Emptying a slot of a
Ready or Scheduled draft by hand also sends it back to Planning. Deleting a draft
leaves a "deleted draft 'X'" line in the feed with who did it.

To apply it (from the site folder, the same way as steps 5-7):

```
npx supabase db push
node tools/leak_test.mjs
```

`db push` should list `20261011200000_workspace.sql`. Every line of the leak test must
say PASS, including the new workspace lines.

## Automatic publishing

A GitHub workflow, **Publish puzzles** (`.github/workflows/publish-puzzles.yml`), turns
workspace drafts into live puzzles. It runs every 10 minutes and does at most one draft
per run, oldest first:

- a **Scheduled** draft whose release time has passed, or
- a draft someone pressed **Publish now** on (it usually goes out within 10 minutes).

Each run builds the puzzle with the same tools you would use by hand
(`build_puzzle.py`, `make_thumbnails.mjs`, `publish.py`, then the puzzle checks),
commits it to `main` as "Publish <title> (<date>) from the workspace", asks GitHub
Pages to rebuild, and marks the draft Published. The database then marks its
suggestions Used and takes them out of other drafts. The puzzle id is the title plus the
release day in Eastern time (`fruit-findings-2026-10-15`); Publish now uses today's date.
The workflow only runs once it is on `main`, so merge `feature/publisher` first.

### One-time setup (two steps)

1. **Make a secret key for the robot.** Supabase dashboard → Project Settings →
   API Keys → Secret keys → Add a new secret key. Name it `githubpublisher` (Supabase allows only letters, numbers and underscores). Copy it
   (it starts with `sb_secret_`). A separate key means you can revoke just this one
   later without breaking the submit function.
2. **Give it to GitHub.** On GitHub, open the repo → Settings → Secrets and variables →
   Actions → New repository secret. Name: `SUPABASE_SECRET_KEY`. Value: the key you
   copied. Save.

That's all. The project address comes from `studio/config.js`. Until the secret exists,
each run just logs "SUPABASE_SECRET_KEY is not set" and stops without failing. Never
paste the key anywhere else: not in this repo, not in `studio/config.js`, not in chat.

### Try it safely first (dry run)

Actions tab → **Publish puzzles** → **Run workflow** → tick **dry_run** → (optional)
paste a draft id into **draft_id** → Run workflow.

A dry run reads the workspace but never changes it, and it does not touch `main`. It
builds the puzzle and pushes the commit to a branch named `publish-dry-run/<puzzle id>`,
which you can open on GitHub to check the files. Pages only publishes `main`, so the
live site stays as it is. Delete the branch afterwards if you like.

### What a failure looks like

Nothing goes live. The draft keeps its status (Ready or Scheduled), and the workspace
shows a red box on it: "Publishing failed at <step>", the reason in plain English (for
example "The picture for clue "X" (tier 1) is not a JPEG, PNG, WebP or GIF file"), and a
**Try again** button. The Actions tab shows a red run with the full log, and GitHub
emails you if your notifications are on. A Scheduled draft that failed is not retried
every 10 minutes: fix the draft (any edit) or press Try again. Trying again never
publishes the same draft twice.

### Things GitHub does that are worth knowing

- **Scheduled runs can be late.** GitHub says the `schedule` event "can be delayed
  during periods of high loads", especially at the start of each hour, and queued runs
  may even be dropped when load is very high
  ([Events that trigger workflows: schedule](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule)).
  A 6:00 AM release usually goes out a few minutes after 6:00, sometimes later.
- **Scheduled workflows switch off after 60 days of quiet.** In a public repo, GitHub
  disables scheduled workflows when there has been no repository activity for 60 days
  (same page). Each publish is a commit, so a weekly puzzle keeps it alive. After a long
  break, check Actions → Publish puzzles; if it says disabled, press **Enable workflow**.
- **Pages rebuild.** Commits pushed by a workflow with its built-in token do not start a
  Pages build by themselves
  ([Configuring a publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)),
  so the publisher asks for one through the API
  ([Request a GitHub Pages build](https://docs.github.com/en/rest/pages/pages#request-a-github-pages-build)).
  If that request fails, the run log says so; the puzzle is committed and appears with
  the next Pages build.

### Picture originals

The committed spec (`puzzles/_spec/<id>.yaml`) names every picture and points at
`../<id>-src/`, the same untracked folder hand-built puzzles use. The originals stay in
the private Supabase bucket (inbox → Download for import); the published WebP copies
are in `puzzles/<id>/`. The spec also keeps each picture's `source:` line from the
submission, so the image credit and license stay on record.

## Multiple schools and the category database

`supabase/migrations/20261013120000_multischool.sql` turns the inbox into a shared
category database that several medical schools' puzzle groups can use. Apply it in the
same release as the new workspace screens (stages S2-S4), not before: today's inbox
still shows Shortlist and Decline buttons, and those two stop working once it is applied
(reading, voting, comments, drafts and publishing keep working).

What it changes:

- **schools** (CMSRU only for now) and **members**: who may sign in, per school, as
  *lead* (manages that school's people), *admin*, or *faculty* (reads, comments,
  approves drafts; never deletes or plans). Everyone on the old admins list becomes a
  CMSRU admin with their name and color. The old table is kept, unused, as
  `admins_pre_multischool`; a view called `admins` stands in for it so the current
  inbox can still list people and change its own name and color.
- **site_owners**: whoever runs the whole site. The migration adds nobody. Right after
  applying it, run this once in the SQL editor (your own sign-in email):
  ```
  insert into public.site_owners (email) values (lower('you@example.edu'));
  ```
- People are managed only through `add_member`, `change_role`, `move_school` (owner
  only) and `set_member_active` (remove/restore access). A lead manages only their own
  school and cannot create leads. Nobody sets passwords; a new member signs up and the
  sign-up hook (same function, same dashboard setting) lets them in because they are
  on the list.
- **Status** is now new / used / trashed. Shortlisted ones became New; declined ones
  moved to the Trash with who, when, and the note as the reason. Trash/Restore is open
  to any school's leads and admins (the bank is shared) and is logged.
- New full-puzzle suggestions are refused by the database (single categories only).
- Fixing an original goes through `edit_submission` (logged in `submission_edits`,
  undoable with `undo_submission_edit`), only for the receiving school's leads/admins
  and the site owner.
- A draft slot may hold an **adapted copy** (`draft_slots.adapted`). New pictures for a
  copy go in the private `submissions` bucket under `drafts/<draft id>/<file>`.
- Drafts, their slots, history, comments and publish jobs are visible only to the
  draft's school (and the site owner). `other_school_releases(from, to)` tells you only
  "School X has a puzzle on this day".
- Publishing records a **category_uses** row per category. A published category is
  taken out of the same school's other drafts only; other schools keep it.

To apply and check (the pglite tests need no Supabase and touch nothing live):

```
npm install --no-save @electric-sql/pglite
node supabase/tests/multischool.test.mjs
node supabase/tests/import_published.test.mjs
npx supabase db push
node tools/leak_test.mjs
```

Then, once, import the categories of puzzles that are already live:

```
node tools/import_published_categories.mjs              # dry run: the list
node tools/import_published_categories.mjs --sql import.sql
```

and paste `import.sql` into the SQL editor. Running it twice is harmless.

**Emptying the Trash automatically** is off: the setting
(`site_settings.trash_retention_days`) starts as "never", and nothing is scheduled. If
you later decide to turn it on, set the number of days in the workspace and schedule the
clean-up once in the SQL editor:

```
select cron.schedule('dp-purge-trash', '23 4 * * *', 'select private.purge_trash()');
```

It never deletes a trashed category that went out in a puzzle or still sits in a draft.
It removes database rows only; the category's pictures stay in the private bucket.
