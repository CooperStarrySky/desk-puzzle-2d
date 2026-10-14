// supabase/tests/db_harness.mjs — a throwaway in-memory Postgres (PGlite) that
// looks enough like a Supabase project to run our migrations and row rules.
// Nothing here talks to the network or to the live database.
//
// Needs the PGlite package once (it is not part of the website):
//     npm install --no-save @electric-sql/pglite
// or point PGLITE_MODULE at an install elsewhere, e.g.
//     PGLITE_MODULE=/path/to/node_modules/@electric-sql/pglite/dist/index.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS = path.resolve(HERE, '..', 'migrations');

async function loadPGlite() {
  const spec = process.env.PGLITE_MODULE;
  const mod = await import(spec ? (spec.startsWith('/') ? pathToFileURL(spec).href : spec) : '@electric-sql/pglite');
  return mod.PGlite;
}

// The bits of Supabase our migrations lean on: the API roles, auth.jwt(),
// the storage tables, and Supabase's habit of granting every new public table
// to anon/authenticated (so a forgotten "revoke" shows up as a leak here too).
const SUPABASE_STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role supabase_auth_admin nologin;
grant anon, authenticated, service_role, supabase_auth_admin to postgres;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role, supabase_auth_admin;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid;
$$;

-- Supabase Auth's user list (only the columns our functions read).
create table auth.users (
  id uuid primary key default gen_random_uuid(), email text, last_sign_in_at timestamptz
);

create schema storage;
grant usage on schema storage to anon, authenticated, service_role;
create table storage.buckets (
  id text primary key, name text not null, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text not null, owner uuid default auth.uid(), created_at timestamptz default now(),
  unique (bucket_id, name)
);
alter table storage.objects enable row level security;
grant all on storage.objects to anon, authenticated, service_role;
create function storage.foldername(name text) returns text[] language plpgsql immutable as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1 : array_length(_parts, 1) - 1];
end $$;
`;

export function migrationFiles() {
  return fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
}

export async function applyMigration(db, file) {
  const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
  try {
    await db.exec(sql);
  } catch (e) {
    throw new Error(`${file}: ${e.message}`);
  }
}

/** A fresh database with the Supabase stand-ins (no migrations yet). */
export async function freshDb() {
  const PGlite = await loadPGlite();
  const db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  return db;
}

/**
 * Runs SQL as someone. who = an email (a signed-in website user),
 * 'anon' (the public key), 'service' (the secret key / publishing job),
 * 'auth' (Supabase Auth's hook role) or 'postgres' (dashboard).
 * Returns { rows, error } and never throws; every call is its own transaction.
 */
export async function as(db, who, sql, params = []) {
  try {
    const rows = await db.transaction(async (tx) => {
      if (who !== 'postgres') {
        const role = who === 'anon' ? 'anon' : who === 'service' ? 'service_role'
          : who === 'auth' ? 'supabase_auth_admin' : 'authenticated';
        const claims = role === 'authenticated' ? { email: who, role, sub: userId(who) } : { role };
        await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
        await tx.exec(`set local role ${role}`);
      }
      const r = await tx.query(sql, params);
      return r.rows;
    });
    return { rows, error: null };
  } catch (e) {
    return { rows: [], error: e.message || String(e) };
  }
}

/** A stable fake user id per email (the JWT "sub"), so storage owners work. */
export function userId(email) {
  let h = 0x811c9dc5;
  const hex = [];
  for (let k = 0; k < 4; k++) {
    for (const ch of String(email) + k) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    hex.push(h.toString(16).padStart(8, '0'));
  }
  const x = hex.join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-4${x.slice(13, 16)}-8${x.slice(17, 20)}-${x.slice(20, 32)}`;
}

export function counter() {
  let fails = 0, passes = 0;
  const ok = (c, m, extra) => {
    console.log((c ? 'PASS ' : 'FAIL ') + m + (!c && extra ? '  [' + extra + ']' : ''));
    if (c) passes++; else fails++;
  };
  return { ok, done: () => ({ fails, passes }) };
}
