/* Browser stand-in for the Supabase client, for the workspace tests. Injected
   before the page loads (the page uses it only on localhost with ?mock). Every
   query goes to pg_server.mjs, which runs it as the signed-in person against a
   PGlite copy of the real database. Password for every test user: "pw". */
(() => {
  const KEY = '__mockEmail';
  const st = window.__mockState = { calls: [], cb: null, delay: 0 };
  const me = () => { try { return sessionStorage.getItem(KEY); } catch (e) { return null; } };
  const session = () => (me() ? { user: { email: me() }, access_token: 'test' } : null);
  const post = async (body) => {
    st.calls.push(body);
    if (st.delay) await new Promise((r) => setTimeout(r, st.delay));
    if (st.failNext) { const m = st.failNext; st.failNext = null; return { data: null, error: { message: m } }; }
    const r = await fetch('/__pg', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ who: me() || 'anon' }, body)) });
    return r.json();
  };
  function from(table) {
    const b = { table, op: 'select', cols: '*', filters: [], order: [], limit: null, patch: null, ret: false };
    const api = {
      select(c) { if (b.op !== 'select') b.ret = true; b.cols = c || '*'; return api; },
      eq(c, v) { b.filters.push(['eq', c, v]); return api; },
      neq(c, v) { b.filters.push(['neq', c, v]); return api; },
      in(c, v) { b.filters.push(['in', c, v]); return api; },
      is(c, v) { b.filters.push(['is', c, v]); return api; },
      gte(c, v) { b.filters.push(['gte', c, v]); return api; },
      lt(c, v) { b.filters.push(['lt', c, v]); return api; },
      overlaps(c, v) { b.filters.push(['overlaps', c, v]); return api; },
      textSearch(c, v) { b.filters.push(['fts', c, v]); return api; },
      order(c, o) { b.order.push([c, !o || o.ascending !== false]); return api; },
      limit(n) { b.limit = n; return api; },
      insert(p) { b.op = 'insert'; b.patch = p; return api; },
      update(p) { b.op = 'update'; b.patch = p; return api; },
      delete() { b.op = 'delete'; return api; },
      then(res, rej) { return post(b).then(res, rej); },
    };
    return api;
  }
  const PIX = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="#b2456e"/></svg>');
  const err = (message) => ({ data: { user: null, session: null }, error: { message, status: 400 } });
  window.__inboxMockClient = {
    from,
    rpc: (name, args) => post({ rpc: name, args: args || {} }),
    storage: { from: (bucket) => ({
      // Uploads go through the real storage.objects row rules (pg_server.mjs); the bytes are kept nowhere.
      upload: async (path, blob, opts) => {
        st.uploads = (st.uploads || []).concat({ path, type: blob && blob.type, size: blob && blob.size });
        return post({ storage: 'upload', bucket, path, upsert: !!(opts && opts.upsert) });
      },
      remove: async (paths) => {
        st.removed = (st.removed || []).concat(paths);
        return post({ storage: 'remove', bucket, paths });
      },
      createSignedUrl: async (p) => ({ data: { signedUrl: PIX + '#' + encodeURIComponent(p) }, error: null }),
      download: async () => ({ data: new Blob([new Uint8Array([82, 73, 70, 70, 1, 2, 3])], { type: 'image/webp' }), error: null }),
    }) },
    auth: {
      getSession: async () => ({ data: { session: session() } }),
      onAuthStateChange: (cb) => { st.cb = cb; return { data: { subscription: { unsubscribe() {} } } }; },
      signInWithPassword: async ({ email, password }) => {
        if (password !== 'pw') return err('Invalid login credentials');
        sessionStorage.setItem(KEY, String(email).toLowerCase());
        if (st.cb) setTimeout(() => st.cb('SIGNED_IN', session()), 0);
        return { data: { user: { email }, session: session() }, error: null };
      },
      signOut: async () => { sessionStorage.removeItem(KEY); if (st.cb) setTimeout(() => st.cb('SIGNED_OUT', null), 0); return { error: null }; },
      signUp: async () => err('Not in the tests'),
      resend: async () => ({ data: {}, error: null }),
      resetPasswordForEmail: async () => ({ data: {}, error: null }),
      verifyOtp: async () => err('Not in the tests'),
      updateUser: async () => ({ data: { user: session() && session().user }, error: null }),
    },
  };
})();
