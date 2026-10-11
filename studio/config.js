/* Desk Puzzle settings for the Studio (studio/?submit) and the inbox (studio/inbox.html).
 *
 * Everything in this file is PUBLIC. It ships with the website, so anyone can
 * read it. That is fine for the four values below: they are designed to be
 * public. NEVER paste the secret key (sb_secret_...) or "service_role" key, the Turnstile SECRET
 * key, or the database password here. Those only ever go into Supabase itself
 * (see supabase/SETUP.md).
 *
 * While supabaseUrl or supabasePublishableKey is blank, the Studio works the old way:
 * students download a file and send it to the puzzle group by hand.
 */
window.DESK_PUZZLE_CONFIG = {
  // Supabase dashboard → the "Connect" button at the top (or Project Settings →
  // Data API) → Project URL. Looks like 'https://abcdefghijklmnop.supabase.co'
  supabaseUrl: 'https://prjdnjmikbwasaolxzxq.supabase.co',

  // Project Settings → API Keys → "API Keys" tab → Publishable key. Starts with
  // sb_publishable_. (An older "anon" key starting with eyJ... also works.)
  // NOT the secret key (sb_secret_...), which must never be in this file.
  supabasePublishableKey: 'sb_publishable_ni-KFVdWHaDR6qSd6XXhxA_jkWNY4Ba',

  // Optional "are you human" check. Cloudflare dashboard → Turnstile → your
  // widget → Site Key (starts with 0x...). Leave blank to skip the check.
  turnstileSiteKey: '',

  // Where students send a downloaded file when online sending is off or fails.
  // Put the group's email address or GroupMe link here, for example
  // 'deskpuzzle@example.com' or 'https://groupme.com/join_group/...'. Emails
  // and https links become clickable automatically.
  submitTo: 'the CMSRU Desk Puzzle group',
};
