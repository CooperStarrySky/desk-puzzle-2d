#!/usr/bin/env node
/* tools/publish_drafts.mjs — the automatic publisher (run by
 * .github/workflows/publish-puzzles.yml every 10 minutes and on demand).
 *
 * One run publishes at most ONE draft from the puzzle workspace:
 *   1. Finds work: "Publish now" requests (publish_jobs, state queued) and
 *      Scheduled drafts whose release time has passed (it files a 'scheduled'
 *      job for those, so every run shows up on the draft). Oldest first.
 *   2. Marks the job running, loads the draft, its 4 slots and categories
 *      (a slot's adapted copy from "Edit for this puzzle" wins over the
 *      original), and downloads the pictures from the private bucket (the
 *      copy's own uploads under drafts/<draft id>/ and clues swapped in from
 *      other categories included) into a temp folder OUTSIDE the repo.
 *   3. Writes the spec and runs the normal pipeline: build_puzzle.py --apply
 *      --set-current, make_thumbnails.mjs --apply, adds "school" to the
 *      index.json entry, publish.py --apply, then validate_puzzle.
 *   4. Commits "Publish <title> (<date>) from the workspace", pushes to main,
 *      asks GitHub Pages to rebuild (pushes made with the Actions token do not
 *      start a Pages build by themselves), marks the draft Published (the
 *      database then marks its suggestions Used) and the job done.
 * Any failure before the push: local changes are undone, nothing is pushed,
 * the job is marked failed with the step and a plain-English reason, and the
 * draft keeps its status. Re-running is safe: a draft already in the repo
 * (spec line "# workspace-draft: <id>") is only marked Published, not rebuilt.
 *
 * The committed spec (puzzles/_spec/<id>.yaml) points its images at
 * ../<id>-src/, the same untracked folder convention as hand-built puzzles.
 * The originals stay in the private Supabase bucket (inbox "Download for
 * import"); the published WebP files are in puzzles/<id>/ under the same names.
 *
 * Usage: node tools/publish_drafts.mjs [--dry-run] [--draft <uuid>]
 * Env:   SUPABASE_SECRET_KEY (sb_secret_..., sent only as the apikey header)
 *        DRY_RUN=true, DRAFT_ID   (the workflow's inputs)
 *        SUPABASE_URL             (optional; default: studio/config.js)
 *        PUBLISH_REMOTE / PUBLISH_BRANCH (default origin / main)
 * Dry run: reads the database but never writes to it; pushes the commit to
 * branch publish-dry-run/<id> instead of main (Pages only deploys main).
 * Exit codes: 0 ok / nothing to do / no secret yet, 1 the run failed.
 * Needs Node 22+, python3 with Pillow + PyYAML, git, and Chrome for the thumbnail. */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { draftSpec, specToYaml, puzzleIdFor, releaseDate } from '../inbox/ws-publish-spec.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const env = process.env;
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] || '' : ''; };
const DRY = flag('--dry-run') || /^(1|true|yes)$/i.test(env.DRY_RUN || '');
const ONLY = (opt('--draft') || env.DRAFT_ID || '').trim();
const KEY = (env.SUPABASE_SECRET_KEY || '').trim();
const REMOTE = env.PUBLISH_REMOTE || 'origin', BRANCH = env.PUBLISH_BRANCH || 'main';
const PY = env.PYTHON || 'python3';
const STALE_MS = 25 * 60 * 1000;
const ID_RE = /^[a-z0-9-]+-[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IMAGE = 15 * 1024 * 1024;

const log = (...a) => console.log('[publish]', ...a);
class StepError extends Error {}
const fail = (msg) => { throw new StepError(msg); };

function projectUrl() {
  if (env.SUPABASE_URL) return env.SUPABASE_URL.replace(/\/+$/, '');
  try {
    const m = /supabaseUrl:\s*'([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'studio', 'config.js'), 'utf8'));
    return m ? m[1].replace(/\/+$/, '') : '';
  } catch (e) { return ''; }
}
const URL_ = projectUrl();

/* ── Supabase (PostgREST + Storage), secret key as the apikey header only ── */
async function api(method, q, body) {
  let r;
  try {
    r = await fetch(URL_ + '/rest/v1/' + q, { method,
      headers: { apikey: KEY, Accept: 'application/json', 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) { throw new Error('could not reach Supabase (' + e.message + ')'); }
  const text = await r.text();
  if (!r.ok) {
    let m = text; try { const j = JSON.parse(text); m = j.message || j.error || text; } catch (e) { /* plain text */ }
    const err = new Error('Supabase said ' + r.status + ': ' + String(m).slice(0, 300)); err.status = r.status; err.body = text;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}
async function download(p) {
  const url = URL_ + '/storage/v1/object/submissions/' + p.split('/').map(encodeURIComponent).join('/');
  let r;
  try { r = await fetch(url, { headers: { apikey: KEY } }); } catch (e) { fail('Could not reach Supabase Storage to download a picture (' + e.message + ').'); }
  if (!r.ok) fail('Could not download the picture "' + p + '" from the private bucket (Supabase said ' + r.status + '). Was the suggestion deleted?');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_IMAGE) fail('The picture "' + p + '" is too big (' + Math.round(buf.length / 1048576) + ' MB).');
  return buf;
}
const now = () => new Date().toISOString();
const inList = (ids) => 'in.(' + ids.map((x) => encodeURIComponent(x)).join(',') + ')';

/* ── Jobs ── */
let JOB = null, STEP = '';
async function patchJob(patch) {
  if (DRY || !JOB) return;
  try { await api('PATCH', 'publish_jobs?id=eq.' + JOB.id, patch); } catch (e) { log('WARN could not update the job row:', e.message); }
}
async function step(name) { STEP = name; log('step:', name); await patchJob({ step: name }); }

async function failStaleJobs() {
  const rows = await api('GET', 'publish_jobs?state=eq.running&select=id,requested_at');
  for (const j of rows || []) {
    if (Date.now() - Date.parse(j.requested_at) < STALE_MS) continue;
    log('marking a stuck job failed:', j.id);
    if (!DRY) await api('PATCH', 'publish_jobs?id=eq.' + j.id + '&state=eq.running', { state: 'failed', finished_at: now(),
      error: 'The publishing run stopped before it finished (GitHub may have cancelled it). Nothing was published. Press Try again.' });
  }
}
const DCOLS = 'id,title,block,school,status,target_release,updated_at,published_puzzle_id';
/* drafts rows; works before the school migration (20261012120000) too: no column -> 'cmsru'. */
async function drafts(filter) {
  try { return (await api('GET', 'drafts?' + filter + '&select=' + DCOLS)) || []; } catch (e) {
    if (!/school/.test(String(e.body || e.message))) throw e;
    return ((await api('GET', 'drafts?' + filter + '&select=' + DCOLS.replace('school,', ''))) || []).map((d) => Object.assign({ school: 'cmsru' }, d));
  }
}
async function getDraft(id) { return (await drafts('id=eq.' + encodeURIComponent(id)))[0] || null; }
async function openJob(draftId) {
  const r = await api('GET', 'publish_jobs?draft_id=eq.' + draftId + '&state=in.(queued,running)&select=*&order=requested_at.desc');
  return r && r[0] ? r[0] : null;
}
async function newJob(draftId, kind) {
  try { const r = await api('POST', 'publish_jobs', { draft_id: draftId, kind }); return r[0]; } catch (e) {
    if (/23505|duplicate/.test(String(e.body || e.message))) return openJob(draftId); // another request got there first
    throw e;
  }
}

/* The next piece of work, { draft, job, kind }, or null when there is none. */
const PUBLISHABLE = ['ready', 'scheduled'];
async function findWork() {
  await failStaleJobs();
  const busy = await api('GET', 'publish_jobs?state=eq.running&select=id,draft_id&limit=1');
  if (busy && busy.length && !DRY) { log('Another publishing run is still working. Trying again next time.'); return null; }
  if (ONLY) {
    if (!UUID_RE.test(ONLY)) throw new Error('"' + ONLY + '" is not a draft id.');
    const d = await getDraft(ONLY);
    if (!d) throw new Error('No draft has the id ' + ONLY + '.');
    let job = await openJob(d.id);
    const due = d.status === 'scheduled' && Date.parse(d.target_release) <= Date.now();
    const kind = job ? job.kind : due ? 'scheduled' : 'now';
    if (DRY) return { draft: d, job: null, kind };
    if (d.status === 'published') { log('Draft "' + d.title + '" is already published (' + d.published_puzzle_id + ').'); return null; }
    if (!PUBLISHABLE.includes(d.status)) throw new Error('Draft "' + d.title + '" is ' + d.status + '. Only a Ready or Scheduled draft can be published.');
    if (!job) job = await newJob(d.id, kind);
    return job ? { draft: d, job, kind: job.kind } : null;
  }
  const queued = (await api('GET', 'publish_jobs?state=eq.queued&select=*&order=requested_at.asc&limit=50')) || [];
  const due = await drafts('status=eq.scheduled&target_release=lte.' + encodeURIComponent(now()) + '&order=target_release.asc&limit=20');
  const cands = queued.map((j) => ({ job: j, at: Date.parse(j.requested_at) }));
  for (const d of due) {
    if (queued.some((j) => j.draft_id === d.id)) continue;
    const last = ((await api('GET', 'publish_jobs?draft_id=eq.' + d.id + '&select=state,requested_at&order=requested_at.desc&limit=1')) || [])[0];
    // A scheduled draft whose last run failed waits for an edit or "Try again" instead of failing every 10 minutes.
    if (last && last.state === 'failed' && Date.parse(last.requested_at) >= Date.parse(d.updated_at)) {
      log('Skipping "' + d.title + '": its last run failed. It waits for an edit or "Try again".'); continue;
    }
    cands.push({ draft: d, at: Date.parse(d.target_release) });
  }
  cands.sort((a, b) => a.at - b.at);
  for (const c of cands) {
    const d = c.draft || (await getDraft(c.job.draft_id));
    if (!d) continue;
    if (c.job && d.status === 'published') {
      if (!DRY) await api('PATCH', 'publish_jobs?id=eq.' + c.job.id, { state: 'done', step: 'Already published as ' + d.published_puzzle_id, finished_at: now() });
      continue;
    }
    if (c.job && !PUBLISHABLE.includes(d.status)) {
      if (!DRY) await api('PATCH', 'publish_jobs?id=eq.' + c.job.id, { state: 'failed', step: 'Checking the draft', finished_at: now(),
        error: 'The draft went back to ' + d.status[0].toUpperCase() + d.status.slice(1) + ' before it could be published. Mark it Ready, then press Publish now again.' });
      continue;
    }
    if (DRY) return { draft: d, job: null, kind: c.job ? c.job.kind : 'scheduled' };
    const job = c.job || (await newJob(d.id, 'scheduled'));
    if (job) return { draft: d, job, kind: job.kind };
  }
  return null;
}

/* ── Local helpers: commands, files ── */
const abs = (rel) => path.join(ROOT, rel);
const readJson = (rel) => JSON.parse(fs.readFileSync(abs(rel), 'utf8'));
function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 });
  const out = (r.stdout || '') + (r.stderr || '') + (r.error ? '\n' + r.error.message : '');
  if (out.trim()) process.stdout.write(out.replace(/\s+$/, '').replace(/^/gm, '    ') + '\n');
  return { code: r.status == null ? -1 : r.status, out };
}
function lastLines(out) {
  const lines = String(out || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const bad = lines.filter((l) => /\[ERR\]|\[FAIL\]|ERROR|error:|fatal:|rejected/i.test(l));
  return (bad.length ? bad : lines.slice(-4)).slice(0, 12).join(' | ').slice(0, 1500) || 'no details';
}
function git(...a) { const r = run('git', a); if (r.code) fail('git ' + a[0] + ' failed: ' + lastLines(r.out)); return r.out.trim(); }
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function isPicture(b) {
  if (!b || b.length < 16) return false;
  return (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || b.subarray(0, 8).equals(PNG) ||
    (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') || b.toString('latin1', 0, 4) === 'GIF8';
}
/* A draft already committed by an earlier run (its spec carries "# workspace-draft: <id>"). */
function alreadyInRepo(draftId) {
  const dir = abs('puzzles/_spec');
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith('.yaml')) continue;
    const head = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 4000);
    const id = f.slice(0, -5);
    if (head.includes('# workspace-draft: ' + draftId + '\n') && fs.existsSync(abs('puzzles/' + id + '.json'))) return id;
  }
  return '';
}
const VALIDATE = [
  'import json, os, sys', 'sys.path.insert(0, "tools")', 'from publish import validate_puzzle', 'pid = sys.argv[1]',
  'p = json.load(open(os.path.join("puzzles", pid + ".json"), encoding="utf-8"))',
  'errors, warnings = validate_puzzle(p, pid + ".json")',
  'for w in warnings: print("[WARN] " + w)', 'for e in errors: print("[ERR] " + e)',
  'print("[OK]   validate_puzzle passed" if not errors else "[FAIL] %d error(s)" % len(errors))', 'sys.exit(1 if errors else 0)'].join('\n');

/* ── Reading a draft and its pictures (exported for tools/publish_drafts_test.mjs) ── */
/* The draft's 4 slots (with any adapted copy made by "Edit for this puzzle"),
   their categories, and the build spec. An adapted slot publishes its copy:
   its own name, explanation and clues, pictures uploaded for this draft
   (drafts/<draft id>/...) and clues swapped in from other categories. */
export async function readDraft(draft, kind) {
  const cols = 'draft_id,tier,submission_id,group_index,custom_group';
  let slots;
  try { slots = (await api('GET', 'draft_slots?draft_id=eq.' + draft.id + '&select=' + cols + ',adapted')) || []; } catch (e) {
    if (!/adapted/.test(String(e.body || e.message))) throw e; // before the multischool migration: no copies yet
    slots = (await api('GET', 'draft_slots?draft_id=eq.' + draft.id + '&select=' + cols)) || [];
  }
  const sids = [...new Set(slots.map((s) => s.submission_id).filter(Boolean))];
  const subs = sids.length ? await api('GET', 'submissions?id=' + inList(sids) + '&select=id,kind,group_name,payload,credit_mode,credit_name,credit_line') : [];
  const date = releaseDate(kind, draft.target_release, Date.now()), id = puzzleIdFor(draft.title, date);
  if (!ID_RE.test(id) || id.length > 120) fail('Could not make a puzzle id from the title "' + draft.title + '". Rename the draft.');
  const built = draftSpec(draft, slots, new Map(subs.map((r) => [r.id, r])), { date, id });
  if (built.problems.length) fail('The draft is not ready to publish. ' + built.problems.join(' '));
  return { slots, subs, built, date, id };
}
/* Every picture the spec names, saved into imgDir under the spec's file names. */
export async function fetchImages(built, imgDir) {
  for (const im of built.images) {
    const what = 'the picture for clue "' + (im.label || im.item) + '" (tier ' + im.tier + ')';
    let buf = null;
    if (im.ref.kind === 'storage') buf = await download(im.ref.path);
    else if (im.ref.kind === 'data') {
      const m = /^data:[^,]*;base64,(.*)$/s.exec(im.ref.value);
      if (!m) fail('Could not read ' + what + ' (not base64 data).');
      buf = Buffer.from(m[1], 'base64');
    } else if (im.ref.kind === 'site') {
      const p = path.resolve(ROOT, im.ref.path);
      if (path.relative(abs('puzzles'), p).startsWith('..') || !fs.existsSync(p)) fail(what + ' points at "' + im.ref.path + '", which is not on the site.');
      buf = fs.readFileSync(p);
    } else fail(what + ' is a link to another website. Upload the picture instead.');
    if (!isPicture(buf)) fail(what[0].toUpperCase() + what.slice(1) + ' is not a JPEG, PNG, WebP or GIF file.');
    fs.writeFileSync(path.join(imgDir, im.file), buf);
  }
}

/* ── One draft, start to finish ── */
async function markPublished(draft, id) {
  await step('Marking the draft published');
  try { await api('PATCH', 'drafts?id=eq.' + draft.id, { status: 'published', published_puzzle_id: id }); } catch (e) {
    fail('The puzzle ' + id + ' is on the site, but the workspace could not mark the draft Published (' + e.message + '). Press Try again: it will not publish the puzzle twice.');
  }
  await patchJob({ state: 'done', step: 'Published as ' + id, error: null, finished_at: now() });
  log('done: published as', id);
}
function requestPagesBuild() {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo || env.PUBLISH_PAGES_BUILD === '0') { log('Not in GitHub Actions: no Pages build requested.'); return; }
  // Pushes made with the Actions token do not start a Pages build by themselves (GitHub docs,
  // "Configuring a publishing source for your GitHub Pages site"), so ask for one.
  const r = run('gh', ['api', '-X', 'POST', 'repos/' + repo + '/pages/builds']);
  if (r.code) log('WARN could not ask GitHub Pages to rebuild (' + lastLines(r.out) + '). The site updates with the next Pages build.');
}
function undo(start, created) {
  run('git', ['reset', '--hard', start]);
  for (const rel of created) fs.rmSync(abs(rel), { recursive: true, force: true });
}

async function publish({ draft, job, kind }) {
  JOB = job;
  let tmp = null, pushed = false, start = '';
  const created = [];
  try {
    await patchJob({ state: 'running', step: 'Starting', error: null, finished_at: null });
    await step('Getting the site ready');
    if (run('git', ['status', '--porcelain', '--untracked-files=no']).out.trim()) fail('The site folder has unsaved changes, so nothing was published.');
    if (!DRY) {
      git('fetch', REMOTE, BRANCH);
      const up = REMOTE + '/' + BRANCH;
      if (run('git', ['merge-base', '--is-ancestor', 'HEAD', up]).code) fail('Publishing only runs from the ' + BRANCH + ' branch. Start the workflow from ' + BRANCH + '.');
      git('reset', '--hard', up);
    }
    start = git('rev-parse', 'HEAD');
    const done = alreadyInRepo(draft.id);
    if (done) {
      log('This draft is already on the site as', done, '(an earlier run stopped before updating the workspace).');
      if (!DRY) await markPublished(draft, done);
      return 0;
    }

    await step('Reading the draft');
    const { built, date, id } = await readDraft(draft, kind);
    const rel = { json: 'puzzles/' + id + '.json', dir: 'puzzles/' + id, spec: 'puzzles/_spec/' + id + '.yaml', thumb: 'puzzles/thumbs/' + id + '.webp' };
    if (fs.existsSync(abs(rel.json)) || fs.existsSync(abs(rel.spec)) || (readJson('puzzles/index.json').puzzles || []).some((p) => p.id === id)) {
      fail('A puzzle with the id "' + id + '" is already on the site. Rename the draft (or publish on another day) and try again.');
    }
    [rel.dir, rel.spec, rel.thumb].forEach((r) => { if (!fs.existsSync(abs(r))) created.push(r); });

    await step('Downloading the pictures');
    tmp = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), 'dp-publish-'));
    if (!path.relative(ROOT, tmp).startsWith('..')) fail('The temp folder is inside the site folder; refusing to continue.');
    const imgDir = path.join(tmp, 'img');
    fs.mkdirSync(imgDir);
    await fetchImages(built, imgDir);

    await step('Writing the puzzle spec');
    const title = String(draft.title).replace(/\s+/g, ' ').trim();
    const header = ['Desk Puzzle spec, written by the automatic publisher (tools/publish_drafts.mjs)',
      'from the workspace draft "' + title + '" (' + (kind === 'scheduled' ? 'scheduled release' : 'Publish now') + ', ' + date + ').',
      'Images: the originals stay in the private Supabase bucket (inbox: "Download for',
      'import"); to rebuild, save them in ../' + id + '-src/ (untracked) under the names below.',
      'The published WebP copies are in puzzles/' + id + '/.',
      'Build check: python3 tools/build_puzzle.py puzzles/_spec/' + id + '.yaml'];
    const tmpSpec = path.join(tmp, id + '.yaml');
    fs.writeFileSync(tmpSpec, specToYaml(built.spec, { header, draftId: draft.id, imagesDir: imgDir }));

    await step('Building the puzzle');
    let r = run(PY, ['tools/build_puzzle.py', tmpSpec, '--apply', '--set-current']);
    if (r.code) fail('The build tool refused the puzzle: ' + lastLines(r.out));
    await step('Making the menu thumbnail');
    r = run(process.execPath, ['tools/make_thumbnails.mjs', id, '--apply']);
    if (r.code) log('WARN no thumbnail (exit ' + r.code + '); the menu card shows its drawn desk instead (publish.py treats this as non-blocking too).');
    const idx = readJson('puzzles/index.json'), entry = (idx.puzzles || []).find((p) => p.id === id);
    if (!entry || idx.current !== id) fail('The build did not add the puzzle to puzzles/index.json as the current puzzle.');
    entry.school = String(draft.school || 'cmsru');
    fs.writeFileSync(abs('puzzles/index.json'), JSON.stringify(idx, null, 2) + '\n');
    await step('Updating the site page');
    r = run(PY, ['tools/publish.py', '--apply']);
    if (r.code) fail('publish.py found a problem: ' + lastLines(r.out));
    await step('Checking the puzzle');
    r = run(PY, ['-c', VALIDATE, id]);
    if (r.code) fail('The finished puzzle did not pass the checks: ' + lastLines(r.out));
    fs.writeFileSync(abs(rel.spec), specToYaml(built.spec, { header, draftId: draft.id, imagesDir: '../' + id + '-src/' }));

    await step(DRY ? 'Saving to a test branch' : 'Saving to GitHub');
    const paths = [rel.json, rel.dir, rel.spec, 'puzzles/index.json', 'index.html', rel.thumb, 'puzzles/thumbs/manifest.json'].filter((p) => fs.existsSync(abs(p)));
    git('add', '--', ...paths);
    const who = run('git', ['config', 'user.email']).out.trim() ? [] : ['-c', 'user.name=Desk Puzzle publisher', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com'];
    git(...who, 'commit', '-q', '-m', 'Publish ' + title + ' (' + date + ') from the workspace');
    if (DRY) {
      const br = 'publish-dry-run/' + id;
      r = run('git', ['push', '--force', REMOTE, 'HEAD:refs/heads/' + br]);
      if (r.code) fail('GitHub refused the test push: ' + lastLines(r.out));
      pushed = true;
      log('DRY RUN done: the commit is on branch', br, '(main and the workspace are unchanged).');
      return 0;
    }
    r = run('git', ['push', REMOTE, 'HEAD:' + BRANCH]);
    if (r.code) {
      log('The push was refused; taking the latest ' + BRANCH + ' and trying once more.');
      if (run('git', ['pull', '--rebase', REMOTE, BRANCH]).code) {
        run('git', ['rebase', '--abort']);
        fail('Someone changed the site at the same moment and the changes clash. Nothing was published. Press Try again.');
      }
      r = run('git', ['push', REMOTE, 'HEAD:' + BRANCH]);
      if (r.code) fail('GitHub refused the push, so nothing was published: ' + lastLines(r.out));
    }
    pushed = true;
    await step('Asking GitHub Pages to rebuild');
    requestPagesBuild();
    await markPublished(draft, id);
    return 0;
  } catch (e) {
    const msg = e instanceof StepError ? e.message : 'Something went wrong while ' + (STEP || 'starting').toLowerCase() + ': ' + e.message;
    log('FAILED at "' + STEP + '": ' + msg);
    if (!pushed && start) undo(start, created);
    await patchJob({ state: 'failed', step: STEP || 'Starting', error: msg.slice(0, 3900), finished_at: now() });
    return 1;
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    if (DRY && pushed && start) undo(start, created); // leave the local folder as it was
  }
}

async function main() {
  if (!KEY) {
    log('SUPABASE_SECRET_KEY is not set, so automatic publishing is not switched on yet. Nothing to do.');
    log('Setup: supabase/SETUP.md, section "Automatic publishing".');
    return 0;
  }
  if (!URL_) { log('ERROR: no Supabase project URL (studio/config.js supabaseUrl).'); return 1; }
  log((DRY ? 'DRY RUN (no database writes, pushes to a publish-dry-run/ branch)' : 'Publishing run') + (ONLY ? ' for draft ' + ONLY : ''));
  let work;
  try { work = await findWork(); } catch (e) { log('ERROR while looking for work: ' + e.message); return 1; }
  if (!work) { log('Nothing to publish right now.'); return 0; }
  log('Draft "' + work.draft.title + '" (' + work.kind + (work.job ? ', job ' + work.job.id : '') + ')');
  return publish(work);
}
// Run only when started as a program (the test imports readDraft/fetchImages).
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
}
