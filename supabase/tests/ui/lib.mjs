// supabase/tests/ui/lib.mjs — helpers for the workspace browser tests: a Chrome
// page with the PGlite-backed client injected, console-error capture, checks.
// Needs pg_server.mjs running (BASE, default http://127.0.0.1:4820).
import fs from 'node:fs';
import { launch } from './cdp.mjs';

const HERE = decodeURIComponent(new URL('.', import.meta.url).pathname);
export const BASE = process.env.BASE || 'http://127.0.0.1:4820';
export { U, C, D } from './seed.mjs';
let pass = 0, fail = 0;
export function check(name, ok, extra) {
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || extra == null ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400)));
}
export function summary() { console.log(`\n${pass} passed, ${fail} failed`); return fail; }
export const resetDb = async () => (await fetch(BASE + '/__reset', { method: 'POST' })).json();
export const sql = async (q, params, who) => (await fetch(BASE + '/__sql', { method: 'POST', body: JSON.stringify({ sql: q, params: params || [], who: who || 'postgres' }) })).json();

let nextPort = 9400 + Math.floor(Math.random() * 300);
// Suites run with "reduce motion" on, so the workspace's animations (ws-motion.js) are
// instant and checks never race a fade. Pass motion: true to test the animations themselves.
export async function page({ width = 1366, height = 900, mobile = false, dark = false, motion = false } = {}) {
  const b = await launch(nextPort++);
  const errors = [];
  b.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'assert')) errors.push('console.error: ' + m.params.args.map((a) => a.value || a.description).join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon/.test(m.params.entry.url || '')) errors.push('log: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
  });
  await b.send('Runtime.enable'); await b.send('Log.enable'); await b.send('Page.enable');
  await b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }, { name: 'prefers-reduced-motion', value: motion ? 'no-preference' : 'reduce' }] });
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync(HERE + 'mock_client.js', 'utf8') });
  const P = Object.assign(b, { errors });
  P.go = async (url) => { await b.send('Page.navigate', { url }); return b.waitFor('document.readyState === "complete"'); };
  P.js = (s) => b.evaluate(s);
  P.click = (sel) => b.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  P.clickText = (sel, text) => b.evaluate(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.trim().includes(${JSON.stringify(text)})); if (!e) return false; e.click(); return true; })()`);
  P.type = (sel, v) => b.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.focus(); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  P.submit = (sel) => b.evaluate(`(() => { const f = document.querySelector(${JSON.stringify(sel)}); if (!f) return false; f.requestSubmit(); return true; })()`);
  P.text = (sel) => b.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
  P.count = (sel) => b.evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  P.attr = (sel, a) => b.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.getAttribute(${JSON.stringify(a)}) : null; })()`);
  P.visible = (sel) => b.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!(e && e.offsetParent !== null); })()`);
  P.focused = () => b.evaluate('(() => { const a = document.activeElement; return a ? (a.id || a.dataset.act || a.className || a.tagName) : null; })()');
  P.key = async (key, code, vk, mods) => {
    for (const type of ['keyDown', 'keyUp']) await b.send('Input.dispatchKeyEvent', { type, key, code: code || key, windowsVirtualKeyCode: vk || 0, modifiers: mods || 0, text: type === 'keyDown' && key.length === 1 ? key : undefined });
  };
  P.overflow = () => b.evaluate('document.documentElement.scrollWidth - window.innerWidth');
  P.toast = () => b.evaluate('document.getElementById("toast").hidden ? "" : document.getElementById("toast").textContent');
  P.names = () => b.evaluate('[...document.querySelectorAll("#sug-list .sug-toggle")].map((x) => x.textContent)');
  let n = 0;
  P.signInAs = async (email, hash) => {
    await P.go(BASE + '/inbox/?mock&n=' + (++n) + (hash || ''));
    await b.waitFor('!document.getElementById("v-signin").hidden || !document.getElementById("v-ws").hidden');
    await P.js('sessionStorage.clear()');
    await P.go(BASE + '/inbox/?mock&n=' + (++n) + (hash || ''));
    await b.waitFor('!document.getElementById("v-signin").hidden');
    await P.type('#signin-email', email); await P.type('#signin-password', 'pw'); await P.submit('#f-signin');
    return b.waitFor('!document.getElementById("v-ws").hidden && document.querySelectorAll("#sug-list .sug-card, #sug-list .empty").length > 0 || !document.getElementById("v-notadmin").hidden');
  };
  /* Waits until the list settles after an action. */
  P.settle = async () => { await b.sleep(150); return b.waitFor('document.getElementById("sug-list") && document.getElementById("sug-list").getAttribute("aria-busy") !== "true"'); };
  return P;
}

/** Game pages: point the public stats address at <same origin>/__stats and answer
    every request there with `rows` (default: no stats yet), so the home page's class
    lines and the results screen load quietly. Any request that still reaches
    *supabase.co* is failed and counted in the returned { live }. Call before P.go. */
export async function stubGameStats(P, rows) {
  const counter = { live: 0 };
  await P.send('Page.addScriptToEvaluateOnNewDocument', { source: `Object.defineProperty(window, 'DESK_PUZZLE_CONFIG', { configurable: true,
    get() { return this.__c; }, set(v) { this.__c = Object.assign({}, v, { supabaseUrl: location.origin + '/__stats' }); } });` });
  await P.send('Fetch.enable', { patterns: [{ urlPattern: '*/__stats/*' }, { urlPattern: '*supabase.co*' }] });
  P.on((m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const u = m.params.request.url, id = m.params.requestId;
    if (/supabase\.co/.test(u)) { counter.live++; P.send('Fetch.failRequest', { requestId: id, errorReason: 'BlockedByClient' }).catch(() => {}); return; }
    const body = /puzzle_stats/.test(u) ? JSON.stringify(rows || []) : '{}';
    P.send('Fetch.fulfillRequest', { requestId: id, responseCode: 200, body: Buffer.from(body).toString('base64'),
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }] }).catch(() => {});
  });
  return counter;
}
