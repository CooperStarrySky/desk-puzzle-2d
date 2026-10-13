#!/usr/bin/env node
// tools/import_published_categories.mjs — put the categories of puzzles that
// are already live into the category database (one-time, after the
// multischool migration). It never talks to a database itself.
//
//     node tools/import_published_categories.mjs                  # dry run: list what would be imported
//     node tools/import_published_categories.mjs --existing rows.json   # ...and preview links to existing suggestions
//     node tools/import_published_categories.mjs --sql out.sql    # write the SQL to paste into the SQL editor
//
// For every group of every puzzle in puzzles/index.json the SQL:
//   * links to an existing suggestion when it is clearly the same category
//     (same name and at least 2 of the same clue labels, or at least 3 of the
//     same clue labels whatever the name); otherwise
//   * adds it as a suggestion: school cmsru, status used, credit "Puzzle group",
//     source 'published', source_ref = the puzzle id. Image clues keep their
//     public site path (puzzles/<id>/<file>.webp);
//   * adds one category_uses row for that puzzle. adapted = false for new rows;
//     for a linked suggestion, adapted = true when the name or clue labels differ.
// Running the SQL twice changes nothing the second time.
//
// rows.json (optional, for the preview only) is an export of
//   select id, group_name, payload from submissions;
// saved as a JSON array. The real matching happens inside the SQL at apply time.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const SQL_OUT = opt('--sql');
const EXISTING = opt('--existing');
const PUZZLES = opt('--puzzles') || path.join(ROOT, 'puzzles');

export const norm = (s) => String(s || '').toLowerCase().replace(/<[^>]*>/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Same rule as the SQL below: returns null, or { adapted } when it is the same category. */
export function matchCategory(pub, cand) {
  const a = new Set((pub.items || []).map((i) => norm(i.label)));
  const b = new Set((cand.items || []).map((i) => norm(i.label)));
  const shared = [...a].filter((x) => b.has(x)).length;
  const sameName = norm(pub.name) === norm(cand.name);
  if (!((sameName && shared >= 2) || shared >= 3)) return null;
  const sameLabels = shared === a.size && a.size === b.size;
  return { adapted: !(sameName && sameLabels) };
}

/** Every published category, shaped like a Studio category payload. */
export function readPublished(dir = PUZZLES) {
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  const out = [];
  for (const p of index.puzzles || []) {
    const file = path.join(dir, p.file);
    if (!fs.existsSync(file)) { console.warn(`skip ${p.id}: ${p.file} not found`); continue; }
    const puz = JSON.parse(fs.readFileSync(file, 'utf8'));
    const byId = new Map((puz.items || []).map((it) => [it.id, it]));
    for (const g of puz.groups || []) {
      const items = (g.itemIds || []).map((id) => byId.get(id)).filter(Boolean).map((it) => {
        const c = { label: it.label, zone: it.zone, info: Object.assign({ title: it.label }, it.info || {}) };
        for (const k of ['scope', 'source', 'note']) if (it[k] != null) c[k] = it[k];
        return c;
      });
      if (items.length !== 4) console.warn(`note: ${p.id} / ${g.name} has ${items.length} clues`);
      const payload = { name: g.name, explanation: g.explanation || '', items };
      if (Array.isArray(g.article)) payload.article = g.article;
      if (g.anki) payload.anki = g.anki;
      out.push({ puzzleId: p.id, puzzleTitle: p.title, date: p.date || puz.date, groupId: g.id, tier: g.tier, payload });
    }
  }
  return out;
}

const lit = (s) => (s == null ? 'null' : "'" + String(s).replace(/'/g, "''") + "'");
const receipt = (c) => 'PUB-' + crypto.createHash('sha256').update(c.puzzleId + '/' + c.groupId).digest('hex').slice(0, 10).toUpperCase();

// The helper lives in pg_temp, so it disappears when the SQL editor session ends.
const HELPER = `
create or replace function pg_temp.dp_norm(s text) returns text language sql immutable as $f$
  select btrim(regexp_replace(regexp_replace(lower(coalesce(s, '')), '<[^>]*>', '', 'g'), '[^a-z0-9]+', ' ', 'g'));
$f$;
create or replace function pg_temp.dp_labels(p jsonb) returns text[] language sql immutable as $f$
  select coalesce(array_agg(distinct pg_temp.dp_norm(i ->> 'label')), '{}') from jsonb_array_elements(coalesce(p -> 'items', '[]')) i;
$f$;
create or replace function pg_temp.dp_import(p_puzzle text, p_date date, p_tier int, p_receipt text, p_payload jsonb)
returns text language plpgsql as $f$
declare
  sid uuid; adapted boolean := false; nm text := p_payload ->> 'name';
  mine text[] := pg_temp.dp_labels(p_payload); theirs text[]; shared int; how text;
begin
  -- Already imported (this exact puzzle group)?
  select id into sid from public.submissions where receipt_code = p_receipt;
  if sid is not null then
    how := 'already imported';
  else
    -- Clearly the same as an existing suggestion?
    select s.id, pg_temp.dp_labels(s.payload) into sid, theirs
    from public.submissions s
    where s.kind = 'category'
      and ((select count(*) from unnest(pg_temp.dp_labels(s.payload)) x where x = any (mine)) >= 3
        or (pg_temp.dp_norm(s.group_name) = pg_temp.dp_norm(nm)
            and (select count(*) from unnest(pg_temp.dp_labels(s.payload)) x where x = any (mine)) >= 2))
    order by (pg_temp.dp_norm(s.group_name) = pg_temp.dp_norm(nm)) desc, s.created_at
    limit 1;
    if sid is not null then
      shared := (select count(*) from unnest(theirs) x where x = any (mine));
      adapted := not (pg_temp.dp_norm((select group_name from public.submissions where id = sid)) = pg_temp.dp_norm(nm)
                      and shared = cardinality(mine) and cardinality(mine) = cardinality(theirs));
      update public.submissions set status = 'used', used_in = coalesce(used_in, p_puzzle) where id = sid and status = 'new';
      how := case when adapted then 'linked (adapted)' else 'linked (as-is)' end;
    else
      insert into public.submissions (kind, status, group_name, payload, credit_mode, credit_name, consent, receipt_code,
                                      school, source, source_ref, used_in, suggested_tier, created_at)
      values ('category', 'used', nm, p_payload, 'named', 'Puzzle group', true, p_receipt,
              'cmsru', 'published', p_puzzle, p_puzzle, p_tier, coalesce(p_date::timestamptz, now()))
      returning id into sid;
      how := 'added';
    end if;
  end if;
  insert into public.category_uses (submission_id, school, draft_id, puzzle_id, puzzle_date, adapted, published_at)
  values (sid, 'cmsru', null, p_puzzle, p_date, adapted, coalesce(p_date::timestamptz, now()))
  on conflict (submission_id, puzzle_id) do nothing;
  return how;
end;
$f$;
`;

export function buildSql(cats) {
  const lines = ['-- Generated by tools/import_published_categories.mjs on ' + new Date().toISOString().slice(0, 10),
    '-- Paste into the Supabase SQL editor AFTER the multischool migration. Safe to run twice.', 'begin;',
    "select set_config('desk.quiet', 'on', true);", HELPER.trim()];
  for (const c of cats) {
    lines.push(`select ${lit(c.puzzleId + ' / ' + c.payload.name)} as category, pg_temp.dp_import(${lit(c.puzzleId)}, ${c.date ? lit(c.date) + '::date' : 'null'}, ${Number.isInteger(c.tier) ? c.tier : 'null'}, ${lit(receipt(c))}, ${lit(JSON.stringify(c.payload))}::jsonb) as result;`);
  }
  lines.push('commit;', '');
  return lines.join('\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cats = readPublished();
  const existing = EXISTING ? JSON.parse(fs.readFileSync(EXISTING, 'utf8')) : null;
  console.log(`${cats.length} published categories in ${new Set(cats.map((c) => c.puzzleId)).size} puzzles:`);
  for (const c of cats) {
    let note = '';
    if (existing) {
      const hit = existing.map((r) => ({ r, m: matchCategory(c.payload, Object.assign({ name: r.group_name }, r.payload || {})) })).find((x) => x.m);
      note = hit ? `  -> links to "${hit.r.group_name}" (${hit.m.adapted ? 'adapted' : 'as-is'})` : '  -> new';
    }
    console.log(`  ${c.puzzleId}  T${c.tier ?? '?'}  ${c.payload.name} (${c.payload.items.length} clues)${note}`);
  }
  if (SQL_OUT) {
    fs.writeFileSync(SQL_OUT, buildSql(cats));
    console.log(`\nWrote ${SQL_OUT}. Nothing was sent anywhere; paste it into the SQL editor when ready.`);
  } else {
    console.log('\nDry run only. Add --sql out.sql to write the SQL.');
  }
}
