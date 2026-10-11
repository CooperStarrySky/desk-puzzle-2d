#!/usr/bin/env node
/* tools/make_thumbnails.mjs — menu thumbnails that show a puzzle's real clues.
 *
 * Opens tools/thumb-render.html?id=<id> in headless Chrome. That page draws
 * the same stylized mini desk as the menu's generated placeholder, but with
 * ~9 real clues from the puzzle (notes, Rx slips, photos, slides, films),
 * picked and placed deterministically from the puzzle id. Nothing reveals a
 * group. The tool screenshots that 800 x 500 drawing (transparent around the
 * tiles, so the card's own light/dark bench shows through) and saves it as
 * puzzles/thumbs/<id>.webp.
 *
 * Usage:
 *   node tools/make_thumbnails.mjs                 # dry run, every puzzle in index.json
 *   node tools/make_thumbnails.mjs <id> [<id>...]  # dry run, just these puzzles
 *   node tools/make_thumbnails.mjs <id> --apply    # write puzzles/thumbs/<id>.webp
 *                                                  # and add "thumb" to index.json
 *   --force   redraw even when nothing changed since last time
 *
 * "Unchanged" means the puzzle JSON, the image files it points at, the render
 * page (tools/thumb-render.*) and the capture settings all match what
 * puzzles/thumbs/manifest.json recorded. The tile colors and fonts come from
 * styles.css, which is not tracked (it changes often): after restyling the
 * menu's mini desk, rerun with --force. Drawing is deterministic, so a forced
 * rerun with nothing changed writes identical bytes.
 *
 * Needs Node 22+ (built-in WebSocket) and Google Chrome (or set CHROME_PATH).
 * No npm packages. Every browser wait gives up after 20 s; Chrome and the
 * local web server are always shut down, even on errors or Ctrl-C.
 *
 * Exit codes: 0 ok, 1 a thumbnail failed, 2 bad arguments / setup problem.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const INDEX_JSON = path.join(ROOT, 'puzzles', 'index.json');
const THUMB_DIR = path.join(ROOT, 'puzzles', 'thumbs');
const MANIFEST = path.join(THUMB_DIR, 'manifest.json');

// Capture settings. Bump CAPTURE_VERSION whenever these change so every
// thumbnail is treated as out of date on the next run.
const CAPTURE_VERSION = 1;
const OUT_W = 800;            // thumbnail size: 16:10, same shape as the menu's .mini frame
const OUT_H = 500;
const QUALITIES = [85, 78, 70, 62];
const MAX_BYTES = 120 * 1024;
const CALL_MS = 20000;        // every CDP call / wait gives up after this

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const kb = (n) => (n / 1024).toFixed(1) + ' KB';
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/* ── Arguments ──────────────────────────────────────────────────── */

function parseArgs(argv) {
  const out = { ids: [], apply: false, force: false };
  for (const a of argv) {
    if (a === '--apply') out.apply = true;
    else if (a === '--force') out.force = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('-')) { console.log('Unknown option: ' + a); process.exit(2); }
    else out.ids.push(a);
  }
  return out;
}

/* ── Cleanup: Chrome, the web server, and the temp profile always go ── */

const cleanups = [];
function cleanupAll() {
  while (cleanups.length) { try { cleanups.pop()(); } catch (e) { /* already gone */ } }
}
process.on('exit', cleanupAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanupAll(); process.exit(130); });
const watchdog = setTimeout(() => {
  console.log('Stopped: the whole run took over 10 minutes.');
  cleanupAll(); process.exit(1);
}, 600000);
watchdog.unref();

/* ── Tiny static file server for the repo (local only) ──────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.ico': 'image/x-icon',
};

function startServer() {
  const server = http.createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { p = '/'; }
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      cleanups.push(() => server.close());
      resolve('http://127.0.0.1:' + server.address().port);
    });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/* ── Headless Chrome over the DevTools protocol ─────────────────── */

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }) || null;
}

/** Launch Chrome with a brand-new throwaway profile and return a small CDP client. */
async function launchChrome(chromePath) {
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dp2d-thumbs-'));
  const proc = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--force-color-profile=srgb', '--font-render-hinting=none', '--window-size=800,500', 'about:blank'],
  { stdio: 'ignore' });
  cleanups.push(() => fs.rmSync(profile, { recursive: true, force: true }));
  cleanups.push(() => proc.kill('SIGKILL'));
  let targets = null;
  const end = Date.now() + CALL_MS;
  while (!targets && Date.now() < end) {
    await sleep(200);
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch (e) { /* not up yet */ }
  }
  const page = targets && targets.find((t) => t.type === 'page');
  if (!page) throw new Error('Chrome did not start within 20 s');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('could not connect to Chrome within 20 s')), CALL_MS);
    ws.addEventListener('open', () => { clearTimeout(t); resolve(); });
    ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('could not connect to Chrome')); });
  });
  cleanups.push(() => ws.close());
  let nextId = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.t);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      consoleErrors.push((d.exception && d.exception.description) || d.text);
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      consoleErrors.push(m.params.entry.text + (m.params.entry.url ? ' ' + m.params.entry.url : ''));
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`Chrome did not answer ${method} within 20 s`)); }, CALL_MS);
    pending.set(id, { resolve, reject, t });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: OUT_W, height: OUT_H, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: 'light' }] });
  // Transparent page background: only the tiles and their shadows are opaque.
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  return { send, evaluate, consoleErrors };
}

/** Draw one puzzle's thumbnail and return { bytes, quality, tiles }. */
async function capture(chrome, origin, id) {
  chrome.consoleErrors.length = 0;
  await chrome.send('Page.navigate', { url: `${origin}/tools/thumb-render.html?id=${encodeURIComponent(id)}` });
  const end = Date.now() + CALL_MS;
  let state = null;
  while (Date.now() < end) {
    state = await chrome.evaluate('window.__thumbError ? "error:" + window.__thumbError : (window.__thumbReady ? "ready" : "")')
      .catch(() => '');
    if (state) break;
    await sleep(100);
  }
  if (!state) throw new Error('the render page was not ready within 20 s');
  if (state.startsWith('error:')) throw new Error(state.slice(6));
  if (chrome.consoleErrors.length) throw new Error('page errors: ' + chrome.consoleErrors.join(' | '));
  const tiles = await chrome.evaluate('window.__thumbTiles');
  let last = null;
  for (const quality of QUALITIES) {
    const r = await chrome.send('Page.captureScreenshot', { format: 'webp', quality,
      clip: { x: 0, y: 0, width: OUT_W, height: OUT_H, scale: 1 } });
    last = { bytes: Buffer.from(r.data, 'base64'), quality, tiles };
    if (last.bytes.length <= MAX_BYTES) return last;
  }
  return last; // still too big at the lowest quality: reported by the caller
}

/* ── Change detection ───────────────────────────────────────────── */

/** Fingerprint of everything that decides how a thumbnail looks (bar styles.css, see header). */
function inputsFingerprint(entry) {
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify({ CAPTURE_VERSION, OUT_W, OUT_H, QUALITIES, id: entry.id }));
  for (const f of ['tools/thumb-render.html', 'tools/thumb-render.js']) h.update(f).update(fs.readFileSync(path.join(ROOT, f)));
  const json = fs.readFileSync(path.join(ROOT, 'puzzles', entry.file));
  h.update(json);
  const refs = [...new Set(String(json).match(/"puzzles\/[^"]+"/g) || [])].map((s) => s.slice(1, -1)).sort();
  for (const r of refs) {
    const p = path.join(ROOT, r);
    h.update(r).update(fs.existsSync(p) ? fs.readFileSync(p) : 'missing');
  }
  return h.digest('hex');
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

/** Put "thumb" right after "file" so index.json stays easy to read. */
function withThumb(entry, thumb) {
  const out = {};
  for (const [k, v] of Object.entries(entry)) {
    if (k === 'thumb') continue;
    out[k] = v;
    if (k === 'file') out.thumb = thumb;
  }
  if (!('thumb' in out)) out.thumb = thumb;
  return out;
}

/* ── Main ───────────────────────────────────────────────────────── */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split(' */')[0]); return 0; }
  const registry = readJson(INDEX_JSON, null);
  if (!registry || !Array.isArray(registry.puzzles)) { console.log('Could not read puzzles/index.json.'); return 2; }
  const all = registry.puzzles;
  const unknown = args.ids.filter((id) => !all.some((p) => p.id === id));
  if (unknown.length) { console.log('Not in puzzles/index.json: ' + unknown.join(', ')); return 2; }
  const entries = args.ids.length ? all.filter((p) => args.ids.includes(p.id)) : all;
  const manifest = readJson(MANIFEST, {});
  console.log(`Menu thumbnails: ${entries.length} puzzle(s)${args.apply ? '' : ' (dry run: nothing is written)'}\n`);

  let chrome = null, origin = null, failed = 0, indexChanged = false, manifestChanged = false;
  const results = [];
  for (const entry of entries) {
    const thumbRel = `puzzles/thumbs/${entry.id}.webp`;
    const thumbAbs = path.join(ROOT, thumbRel);
    const existing = fs.existsSync(thumbAbs) ? fs.readFileSync(thumbAbs) : null;
    const inputs = inputsFingerprint(entry);
    const rec = manifest[entry.id];
    let status, bytes = existing, note = '';
    if (!args.force && existing && rec && rec.inputs === inputs && rec.webp === sha(existing)) {
      status = 'unchanged';
    } else {
      try {
        if (!chrome) {
          const chromePath = findChrome();
          if (!chromePath) { console.log('Google Chrome not found. Install it or set CHROME_PATH.'); return 2; }
          origin = await startServer();
          chrome = await launchChrome(chromePath);
        }
        const shot = await capture(chrome, origin, entry.id);
        bytes = shot.bytes;
        note = ` (quality ${shot.quality}; ${shot.tiles.length} clues: ${shot.tiles.map((t) => t.split(':')[0]).join(', ')})`;
        if (bytes.length > MAX_BYTES) note += ` WARNING: over the ${kb(MAX_BYTES)} budget`;
        status = !existing ? 'new' : existing.equals(bytes) ? 'unchanged' : 'updated';
      } catch (e) {
        failed++;
        console.log(`  FAILED   ${entry.id}: ${e.message}`);
        continue;
      }
    }
    const newRec = { inputs, webp: sha(bytes) };
    if (!rec || rec.inputs !== newRec.inputs || rec.webp !== newRec.webp) { manifest[entry.id] = newRec; manifestChanged = true; }
    if (entry.thumb !== thumbRel) indexChanged = true;
    results.push({ entry, thumbRel, thumbAbs, bytes, status });
    const verb = status === 'unchanged' ? 'unchanged' : args.apply ? (status === 'new' ? 'created' : 'updated') : `would be ${status === 'new' ? 'created' : 'updated'}`;
    console.log(`  ${verb.padEnd(16)} ${thumbRel}  ${kb(bytes.length)}${status === 'unchanged' ? '' : note}`);
  }

  if (args.apply) {
    fs.mkdirSync(THUMB_DIR, { recursive: true });
    for (const r of results) if (r.status !== 'unchanged') fs.writeFileSync(r.thumbAbs, r.bytes);
    if (manifestChanged) {
      const sorted = Object.fromEntries(Object.keys(manifest).sort().map((k) => [k, manifest[k]]));
      fs.writeFileSync(MANIFEST, JSON.stringify(sorted, null, 2) + '\n');
    }
    if (indexChanged) {
      const done = new Map(results.map((r) => [r.entry.id, r.thumbRel]));
      registry.puzzles = all.map((p) => (done.has(p.id) ? withThumb(p, done.get(p.id)) : p));
      fs.writeFileSync(INDEX_JSON, JSON.stringify(registry, null, 2) + '\n');
    }
  }
  const changed = results.filter((r) => r.status !== 'unchanged').length;
  console.log('');
  if (indexChanged) console.log(args.apply ? 'puzzles/index.json: "thumb" fields added.' : 'puzzles/index.json: would add "thumb" fields.');
  if (failed) console.log(`${failed} thumbnail(s) failed; see above. Nothing else was affected.`);
  else if (!changed && !indexChanged) console.log('All thumbnails are up to date.');
  else if (!args.apply) console.log('Dry run. Add --apply to write these files.');
  else console.log('Done. Commit puzzles/thumbs/ and puzzles/index.json.');
  return failed ? 1 : 0;
}

main().then((code) => { cleanupAll(); process.exit(code); }, (e) => {
  console.log('Stopped: ' + (e && e.message));
  cleanupAll(); process.exit(1);
});
