// The "submit" function's logic, kept free of Deno-only code so node tests can
// drive it with a fake database. index.ts only wires it to Deno.serve.
//
// A request is: POST JSON { submission, turnstileToken, website }
//   submission      the same object the Studio downloads (desk-puzzle-submission v1)
//   turnstileToken  Cloudflare's "are you human" token (only checked if TURNSTILE_SECRET is set)
//   website         honeypot: a hidden field people never fill in; bots often do
// Reply: { ok: true, receipt: "DP-XXXX-XXXX" } or { ok: false, error: "plain English" }.

import { LIMITS, validateSubmission, itemIds, receiptCode } from './validate.js';

export const DEFAULT_ORIGINS = 'https://cooperstarrysky.github.io,http://localhost:4607';
export const BUCKET = 'submissions';
export const RATE_PER_HOUR = 5;
const DEFAULT_SALT = 'desk-puzzle-submit-rate-v1';
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * deps:
 *   env(name)        -> string | undefined   (Deno.env.get)
 *   supabase         service-role supabase-js client (or a test fake)
 *   fetch            for Turnstile
 *   now()            -> Date            (optional)
 *   randomUUID()     -> string          (optional)
 *   randomBytes(n)   -> Uint8Array      (optional)
 */
export function createHandler(deps) {
  const env = (k) => (deps.env ? deps.env(k) : undefined);
  const now = deps.now || (() => new Date());
  const uuid = deps.randomUUID || (() => crypto.randomUUID());
  const rand = deps.randomBytes || ((n) => crypto.getRandomValues(new Uint8Array(n)));
  const db = deps.supabase;
  const origins = String(env('ALLOWED_ORIGINS') || DEFAULT_ORIGINS).split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);

  return async function handle(req) {
    const origin = (req.headers.get('origin') || '').replace(/\/+$/, '');
    const allowed = origins.includes(origin);
    const cors = allowed ? {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    } : { Vary: 'Origin' };
    const reply = (status, body) => new Response(JSON.stringify(body), {
      status, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors),
    });
    const fail = (status, error, extra) => reply(status, Object.assign({ ok: false, error }, extra || {}));

    if (req.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });
    if (!allowed) return fail(403, 'Submissions can only be sent from the Desk Puzzle website.');
    if (req.method !== 'POST') return fail(405, 'Send submissions with POST.');

    // ── Size and shape ──
    const declared = Number(req.headers.get('content-length') || 0);
    if (declared > LIMITS.maxBodyBytes) return fail(413, tooBig(declared));
    let raw;
    try { raw = await req.text(); } catch (e) { return fail(400, 'We could not read what was sent. Please try again.'); }
    const bytes = new TextEncoder().encode(raw).length;
    if (bytes > LIMITS.maxBodyBytes) return fail(413, tooBig(bytes));
    let body;
    try { body = JSON.parse(raw); } catch (e) { return fail(400, 'That did not look like a category submission.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'That did not look like a category submission.');

    // ── Honeypot ──
    if (typeof body.website === 'string' && body.website.trim()) {
      return fail(400, 'This form looked like it was filled in automatically. Reload the page and try again.');
    }

    // ── Turnstile (only when the secret is set) ──
    const ip = clientIp(req);
    const secret = env('TURNSTILE_SECRET');
    if (secret) {
      const token = typeof body.turnstileToken === 'string' ? body.turnstileToken : '';
      if (!token) return fail(400, 'Please finish the “are you human” check, then send again.');
      let good = false;
      try {
        const form = new URLSearchParams({ secret, response: token });
        if (ip) form.set('remoteip', ip);
        const r = await deps.fetch(SITEVERIFY, { method: 'POST', body: form });
        const j = await r.json();
        good = !!(j && j.success);
      } catch (e) { good = false; }
      if (!good) return fail(403, 'The “are you human” check did not go through. Please try it again.', { retryTurnstile: true });
    }

    // ── Rate limit: RATE_PER_HOUR attempts per IP per hour ──
    const t = now();
    const ipHash = await sha256Hex((env('RATE_SALT') || DEFAULT_SALT) + '|' + (ip || 'unknown'));
    try {
      await db.from('submit_rate').delete().lt('at', new Date(t.getTime() - 24 * 3600e3).toISOString());
      const { count, error } = await db.from('submit_rate').select('ip_hash', { count: 'exact', head: true })
        .eq('ip_hash', ipHash).gte('at', new Date(t.getTime() - 3600e3).toISOString());
      if (error) throw error;
      if ((count || 0) >= RATE_PER_HOUR) {
        return fail(429, 'That is a lot of categories in one hour. Please wait a bit and send this one later. Your draft is still saved.');
      }
      const ins = await db.from('submit_rate').insert({ ip_hash: ipHash, at: t.toISOString() });
      if (ins && ins.error) throw ins.error;
    } catch (e) {
      return fail(503, 'The submission box is not answering right now. Please try again in a few minutes.');
    }

    // ── Validate ──
    const sub = body.submission;
    const { problems, images } = validateSubmission(sub);
    if (problems.length) {
      const first = problems.slice(0, 3).join('; ');
      return fail(400, 'Please fix this and send again: ' + first + (problems.length > 3 ? ` (and ${problems.length - 3} more)` : '') + '.', { problems });
    }

    // ── Store images, then the row; undo the images if anything fails ──
    const id = uuid();
    const group = JSON.parse(JSON.stringify(sub.group));
    const ids = itemIds(group.items);
    const uploaded = [];
    try {
      for (const im of images) {
        const path = `${id}/${ids[im.item]}-${im.field}.${im.ext}`;
        const { error } = await db.storage.from(BUCKET).upload(path, im.bytes, { contentType: im.mime, upsert: false });
        if (error) throw new Error('upload: ' + (error.message || error));
        uploaded.push(path);
        group.items[im.item][im.field].image = path;
      }
      const credit = sub.credit;
      const email = sub.contact && typeof sub.contact.email === 'string' ? sub.contact.email.trim() : '';
      const row = {
        id, kind: 'category', suggested_tier: sub.suggestedTier, group_name: group.name.trim(), payload: group,
        credit_mode: credit.mode,
        credit_name: credit.mode === 'named' ? credit.name.trim() : null,
        credit_line: credit.mode === 'named' && typeof credit.line === 'string' && credit.line.trim() ? credit.line.trim() : null,
        contact_email: email || null, consent: true,
      };
      for (let attempt = 0; ; attempt++) {
        row.receipt_code = receiptCode(rand);
        const { error } = await db.from('submissions').insert(row);
        if (!error) break;
        // 23505 = unique clash on receipt_code (very rare): pick a new code.
        if (error.code === '23505' && attempt < 3) continue;
        throw new Error('insert: ' + (error.message || error));
      }
      return reply(200, { ok: true, receipt: row.receipt_code });
    } catch (e) {
      if (uploaded.length) {
        try { await db.storage.from(BUCKET).remove(uploaded); } catch (e2) { /* best effort */ }
      }
      console.error('submit failed', e && e.message);
      return fail(500, 'We could not save your category just now, and nothing was kept. Please try again in a few minutes.');
    }
  };
}

function tooBig(n) {
  return `This submission is too big (${(n / 1048576).toFixed(1)} MB; ${LIMITS.maxBodyBytes / 1048576} MB max). Use fewer or smaller images.`;
}

export function clientIp(req) {
  const h = (k) => (req.headers.get(k) || '').trim();
  return h('cf-connecting-ip') || h('x-forwarded-for').split(',')[0].trim() || h('x-real-ip') || '';
}

export async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The privileged key for the function's own client. Newest first:
 *   DP_SECRET_KEY            a secret key (sb_secret_...) Thirth stores with
 *                            `supabase secrets set DP_SECRET_KEY=...` (names
 *                            starting with SUPABASE_ are reserved by Supabase)
 *   SUPABASE_SECRET_KEY      in case Supabase injects one under this name
 *   SUPABASE_SECRET_KEYS     JSON map of secret keys some projects get injected
 *   SUPABASE_SERVICE_ROLE_KEY the legacy service_role JWT, auto-injected today
 */
export function pickServerKey(env) {
  const get = (k) => String(env(k) || '').trim();
  if (get('DP_SECRET_KEY')) return get('DP_SECRET_KEY');
  if (get('SUPABASE_SECRET_KEY')) return get('SUPABASE_SECRET_KEY');
  const many = get('SUPABASE_SECRET_KEYS');
  if (many) {
    try {
      const m = JSON.parse(many);
      const v = m && (m.default || Object.values(m)[0]);
      if (typeof v === 'string' && v) return v;
    } catch (e) { /* not JSON; ignore */ }
  }
  return get('SUPABASE_SERVICE_ROLE_KEY');
}
