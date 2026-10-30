// supabase/tests/ui/cdp.mjs — headless Chrome driver with hard timeouts: every call fails after 20 s instead of hanging,
// renderer crashes are reported, and Chrome is always killed on exit.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = new Set(), dirs = new Set();
// Each Chrome gets a throwaway profile folder (~15 MB); remove it once Chrome is gone so runs don't fill the disk.
const rmDir = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* busy: left for the OS */ } dirs.delete(d); };
const killAll = () => { procs.forEach((p) => { try { p.kill('SIGKILL'); } catch (e) { /* gone */ } }); dirs.forEach(rmDir); };
process.on('exit', killAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { killAll(); process.exit(130); });
process.on('uncaughtException', (e) => { console.log('FAIL harness error: ' + (e && e.message)); killAll(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.log('FAIL harness error: ' + (e && e.message)); killAll(); process.exit(1); });
// Whole-run watchdog: nothing in these suites should take 6 minutes.
const watchdog = setTimeout(() => { console.log('FAIL watchdog: run took over 6 minutes'); killAll(); process.exit(1); }, 360000);
watchdog.unref();

export async function launch(port = 9333, callMs = 20000) {
  const dir = fs.mkdtempSync((process.env.TMPDIR || '/tmp/') + 'cdp-');
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,1000', 'about:blank'], { stdio: 'ignore' });
  procs.add(proc); dirs.add(dir); proc.on('exit', () => rmDir(dir));
  let ver;
  for (let i = 0; i < 50 && !ver; i++) { await sleep(200); try { ver = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch (e) { /* not up */ } }
  const page = ver.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pending = new Map(); const listeners = [];
  let crashed = false;
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.t); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    else if (m.method) {
      if (m.method === 'Inspector.targetCrashed') { crashed = true; console.log('  !! page renderer crashed'); }
      listeners.forEach((l) => { try { l(m); } catch (e) { console.log('  (listener error: ' + e.message + ')'); } });
    }
  });
  const send = (method, params = {}, ms = callMs) => new Promise((res, rej) => {
    const i = ++id;
    const t = setTimeout(() => { pending.delete(i); rej(new Error(`CDP ${method} got no answer in ${ms / 1000}s${crashed ? ' (renderer crashed)' : ''}`)); }, ms);
    pending.set(i, { res, rej, t });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const on = (fn) => listeners.push(fn);
  const evaluate = async (expr, ms) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, ms);
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  };
  const shot = async (file) => { const r = await send('Page.captureScreenshot', { format: 'png' }, 30000); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); };
  /** Polls expr until truthy; returns false after ms (never hangs). */
  const waitFor = async (expr, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (crashed) return false;
      if (await evaluate(expr, 5000).catch(() => false)) return true;
      await sleep(100);
    }
    return false;
  };
  const close = () => { try { ws.close(); } catch (e) { /* */ } try { proc.kill('SIGKILL'); } catch (e) { /* */ } procs.delete(proc); };
  await send('Inspector.enable').catch(() => {});
  return { send, on, evaluate, shot, waitFor, close, sleep, isCrashed: () => crashed };
}
