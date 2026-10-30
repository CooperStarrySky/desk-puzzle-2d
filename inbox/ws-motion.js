/* Puzzle workspace: shared motion. Every animation in the workspace goes
   through here (JS) or ws-motion.css (CSS), so speeds live in one place.
   Rules: quick and calm (150-250 ms, ease-out), visual only (the state has
   already changed when an animation starts, nothing waits for one), and with
   "reduce motion" switched on everything is instant: each helper below just
   runs the change and returns. */

export const DUR = { fast: 150, base: 200, slow: 250 };
export const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const MAX_ITEMS = 150; // long lists: skip the per-item glide, just redraw

export const reduced = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
const canAnimate = (el) => !!(el && el.animate && el.isConnected && !reduced() && !document.hidden);
const inView = (r) => r.bottom > -40 && r.top < innerHeight + 40 && r.width > 0;

function play(el, frames, o) {
  if (!canAnimate(el)) return null;
  const a = el.animate(frames, Object.assign({ duration: DUR.base, easing: EASE }, o));
  a.addEventListener('cancel', () => {}); // a cancelled animation is fine: nothing waits on it
  return a;
}
const stop = (el) => { if (el && el.getAnimations) el.getAnimations().forEach((a) => { if (a.id === 'm') a.cancel(); }); };

/* Fades new content in (a tab, a redrawn list, a calendar month). dir: px to
   slide in from (sideways); without it, opacity only, so menus inside that sit
   at fixed positions are never thrown off by a transform. */
export function enter(el, dir) {
  if (!canAnimate(el)) return;
  stop(el);
  const a = play(el, dir ? [{ opacity: 0, transform: 'translateX(' + dir + 'px)' }, { opacity: 1, transform: 'none' }] : [{ opacity: 0 }, { opacity: 1 }], { duration: DUR.base });
  if (a) a.id = 'm';
}

/* Runs mutate(), then smoothly resizes the elements that sel picks out from
   their old size to the new one (prop: 'height' or 'width'). Elements are
   matched by key(el), so mutate() may redraw them. clip: hide overflow while
   it runs (content is revealed, not squashed). */
export function morph(sel, mutate, o) {
  o = o || {};
  const prop = o.prop || 'height', key = o.key || ((el) => el.id || el.dataset.t || el.className), root = o.root || document;
  if (reduced()) { mutate(); return; }
  const pick = () => (typeof sel === 'function' ? sel() : Array.from(root.querySelectorAll(sel))).filter(Boolean);
  const before = new Map();
  pick().forEach((el) => { before.set(key(el), el.getBoundingClientRect()[prop]); stop(el); });
  mutate();
  pick().forEach((el) => {
    const from = before.get(key(el)); if (from == null) return;
    const to = el.getBoundingClientRect()[prop];
    if (Math.abs(to - from) < 2) return;
    const f0 = { [prop]: from + 'px' }, f1 = { [prop]: to + 'px' };
    if (o.clip !== false) { f0.overflow = 'hidden'; f1.overflow = 'hidden'; }
    const a = play(el, [f0, f1], { duration: o.duration || DUR.base });
    if (a) a.id = 'm';
  });
}

/* Runs mutate(), then glides a grid's columns from the old track sizes to the
   new ones (the Category database's filter sidebar folding). */
export function morphGrid(el, mutate) {
  if (!canAnimate(el)) { mutate(); return; }
  stop(el);
  const from = getComputedStyle(el).gridTemplateColumns;
  mutate();
  const to = getComputedStyle(el).gridTemplateColumns;
  if (from === to || from.split(' ').length !== to.split(' ').length) return;
  const a = play(el, [{ gridTemplateColumns: from }, { gridTemplateColumns: to }], { duration: DUR.base });
  if (a) a.id = 'm';
}

/* FLIP: runs mutate() (which may redraw the whole container), then glides each
   item that is still there from where it was to where it is now. New items
   fade in (or fly in from o.source(key), a rect); items that left fade out as a
   ghost: an inert, attribute-less copy that is removed as soon as it has
   faded (o.exit: 'slide' slides it sideways too). */
export function flip(container, sel, key, mutate, o) {
  o = o || {};
  if (reduced() || !container || !container.isConnected) { mutate(); return; }
  const items = Array.from(container.querySelectorAll(sel));
  if (items.length > MAX_ITEMS) { mutate(); return; }
  const before = new Map();
  items.forEach((el) => { const k = key(el); if (k != null) before.set(k, { r: el.getBoundingClientRect(), el }); stop(el); });
  mutate();
  const now = container.isConnected ? container : null;
  if (!now) return;
  const after = Array.from(now.querySelectorAll(sel));
  if (after.length > MAX_ITEMS) return;
  const seen = new Set();
  after.forEach((el) => {
    const k = key(el); if (k == null) return;
    seen.add(k);
    const b = before.get(k), r = el.getBoundingClientRect();
    if (!inView(r) && !(b && inView(b.r))) return;
    let a = null;
    if (b) {
      const dx = b.r.left - r.left, dy = b.r.top - r.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      a = play(el, [{ transform: 'translate(' + dx + 'px, ' + dy + 'px)' }, { transform: 'none' }], { duration: DUR.slow });
      lift(el, a, o.lift);
    } else if (o.enter !== false) {
      const s = o.source && o.source(k);
      if (s) { a = play(el, [{ transform: 'translate(' + (s.left - r.left) + 'px, ' + (s.top - r.top) + 'px)', opacity: 0.6 }, { transform: 'none', opacity: 1 }], { duration: DUR.slow }); lift(el, a, o.lift); }
      else a = play(el, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: DUR.base });
    }
    if (a) a.id = 'm';
  });
  if (!o.exit) return;
  const cr = now.getBoundingClientRect();
  // One or two cards leaving (Trash, Restore) slide out; a filter change that drops many just fades them.
  const gone = Array.from(before.entries()).filter(([k, b]) => !seen.has(k) && inView(b.r));
  if (gone.length > 12) return;
  gone.forEach(([, b]) => ghost(now, b.el, b.r, cr, gone.length <= 3 ? o.exit : 'fade'));
}

/* While an item travels outside its own box, it gets class m-lift (CSS lets it
   show over its neighbours); the class goes when the glide ends. */
function lift(el, a, on) {
  if (!a || !on) return;
  el.classList.add('m-lift');
  const off = () => el.classList.remove('m-lift');
  a.addEventListener('finish', off); a.addEventListener('cancel', off);
}

/* A copy of a removed item, drawn where it was, that fades out and is gone. */
function ghost(parent, el, r, cr, how) {
  const g = el.cloneNode(true);
  [g].concat(Array.from(g.querySelectorAll('*'))).forEach((n) => {
    Array.from(n.attributes).forEach((at) => { if (at.name === 'id' || at.name === 'for' || at.name === 'name' || at.name === 'href' || at.name === 'tabindex' || at.name.startsWith('data-') || at.name.startsWith('aria-')) n.removeAttribute(at.name); });
  });
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
  g.classList.add('m-ghost'); g.setAttribute('aria-hidden', 'true'); g.inert = true;
  Object.assign(g.style, { left: (r.left - cr.left - parent.clientLeft + parent.scrollLeft) + 'px', top: (r.top - cr.top - parent.clientTop + parent.scrollTop) + 'px', width: r.width + 'px', height: r.height + 'px' });
  parent.appendChild(g);
  const a = play(g, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: how === 'slide' ? 'translateX(28px)' : 'scale(0.98)' }], { duration: DUR.base, easing: 'ease-in' });
  if (!a) { g.remove(); return; }
  const gone = () => g.remove();
  a.addEventListener('finish', gone); a.addEventListener('cancel', gone);
  setTimeout(gone, DUR.base + 200); // belt and braces: a ghost never outlives its fade
}

/* How many ghosts are on screen right now (tests use this). */
export const ghosts = () => document.querySelectorAll('.m-ghost').length;
