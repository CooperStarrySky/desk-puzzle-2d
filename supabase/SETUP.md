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
