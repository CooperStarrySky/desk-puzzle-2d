/**
 * idb-kv.js: a tiny promise wrapper over IndexedDB used as a key/value store.
 *
 * Studio drafts with many images outgrow localStorage (about 5 MB per site),
 * so they live here instead. One database ("dp2d"), one object store ("kv"),
 * values stored as structured clones (plain objects are fine).
 *
 * Every function rejects when IndexedDB is missing or blocked (private mode in
 * some browsers, disabled storage); callers fall back to localStorage.
 */

var DB_NAME = 'dp2d';
var STORE = 'kv';
var dbPromise = null;

/** True when this browser exposes IndexedDB at all (it can still fail to open). */
export function idbSupported() {
  try { return typeof indexedDB !== 'undefined' && !!indexedDB; } catch (e) { return false; }
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(function (resolve, reject) {
    if (!idbSupported()) { reject(new Error('IndexedDB unavailable')); return; }
    var req;
    try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = function () {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = function () {
      var db = req.result;
      // Another tab upgrading the schema: let it, and reopen next time.
      db.onversionchange = function () { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = function () { reject(req.error || new Error('IndexedDB open failed')); };
    req.onblocked = function () { reject(new Error('IndexedDB open blocked')); };
  });
  // A failed open should not stick forever (e.g. a transient block).
  dbPromise.catch(function () { dbPromise = null; });
  return dbPromise;
}

function run(mode, fn) {
  return openDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx;
      try { tx = db.transaction(STORE, mode); } catch (e) { reject(e); return; }
      var out;
      var req = fn(tx.objectStore(STORE));
      req.onsuccess = function () { out = req.result; };
      // Resolve on transaction complete so a write is durable before we say "saved".
      tx.oncomplete = function () { resolve(out); };
      tx.onerror = function () { reject(tx.error || req.error || new Error('IndexedDB transaction failed')); };
      tx.onabort = function () { reject(tx.error || new Error('IndexedDB transaction aborted')); };
    });
  });
}

/** Value for key, or undefined when absent. */
export function idbGet(key) { return run('readonly', function (s) { return s.get(key); }); }
/** Store value under key (resolves once committed). */
export function idbSet(key, value) { return run('readwrite', function (s) { return s.put(value, key); }); }
/** Remove key (resolves once committed; fine if it was absent). */
export function idbDel(key) { return run('readwrite', function (s) { return s.delete(key); }); }
