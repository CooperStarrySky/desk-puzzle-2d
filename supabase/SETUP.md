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

## 3. Tell sign-in where the inbox lives

In the dashboard, go to **Authentication → URL Configuration**.

1. **Site URL:** `https://cooperstarrysky.github.io/desk-puzzle-2d/`
2. Under **Redirect URLs**, add both of these:
   - `https://cooperstarrysky.github.io/desk-puzzle-2d/**`
   - `http://localhost:4607/**`
3. Click **Save**.

The inbox signs people in with an emailed link. These settings make that link come back
to the inbox and nowhere else.

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

Give the function your secret key. Supabase is retiring the older "service_role" key
during 2026, so set the new one now. Easiest and safest is the dashboard:
**Edge Functions → Secrets → Add new secret**, name `DP_SECRET_KEY`, value = your
secret key from **Project Settings → API Keys** (starts with `sb_secret_`). Or in
Terminal (this leaves the key in your Terminal history, so the dashboard is better):

```bash
supabase secrets set DP_SECRET_KEY=sb_secret_paste_yours_here
```

Until this is set, the function falls back to the older service_role key, which works for now.

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
2. Open `https://cooperstarrysky.github.io/desk-puzzle-2d/studio/inbox.html`, type your
   email, and open the link it sends you on the same device.
3. You should see the test category. Open it, click **Decline**, and add the note "test".
4. Send a real one from `studio/?submit` on your phone and check that it shows up.

## Optional: the "are you human" check (Cloudflare Turnstile)

Turn this on if spam ever shows up. It's free.

1. Make a free Cloudflare account at <https://dash.cloudflare.com>, open **Turnstile**,
   and click **Add widget**. Hostnames: `cooperstarrysky.github.io` and `localhost`.
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
- **Sign-in emails are rate-limited.** Supabase's built-in email sender only sends a few
  emails an hour, which is fine for a handful of admins. If someone can't get a link,
  wait a bit and try again.
- **Hourly limit:** each internet connection can send 5 categories an hour.
- **Size limits:** up to 8 images, 700 KB each, about 7 MB in total. The Studio warns
  before sending if something's too big.
- **Getting categories into a puzzle:** in the inbox, open a category and click
  **Download for import**, or click **Download all shortlisted**. Then carry on with
  `tools/import_submission.py` as described in the README ("Category submissions").
- **Deleting a submission:** the inbox can't delete, on purpose (declined ones stay as
  a record). To really delete one, use the dashboard's **Table Editor**.
