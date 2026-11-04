// node supabase/tests/ui/plan_drop.e2e.mjs  (needs pg_server.mjs running)
// Dropping a Database card on a draft slot places it and never falls through to
// the browser (which opens the dragged text in a new tab). Firefox aims drag
// events at the text node inside an element, so the drop is fired on text here.
import { page, check, summary, resetDb, U, D } from './lib.mjs';

await resetDb();
const P = await page({ width: 1400, height: 900 });
check('D0 admin signs in', await P.signInAs(U.ADMIN));
await P.js('location.hash = "#/planner/' + D.cmsru + '"'); await P.waitFor('!!document.querySelector("#slots .slot") && !!document.querySelector("#lib-list .lib-card[draggable=true]")');
const r = await P.js(`(() => {
  const empty = [...document.querySelectorAll('#slots .slot')].find((s) => !s.classList.contains('filled'));
  const card = [...document.querySelectorAll('#lib-list .lib-card[draggable=true]')].find((c) => !c.classList.contains('in-use'));
  if (!empty || !card) return { err: 'no empty slot or free card' };
  const textIn = (el) => { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.data.trim() ? 1 : 3 }); return w.nextNode(); };
  const dt = new DataTransfer();
  const fire = (node, type) => { const e = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }); node.dispatchEvent(e); return e.defaultPrevented; };
  fire(textIn(card), 'dragstart');
  const over = fire(textIn(empty) || empty, 'dragover');
  const drop = fire(textIn(empty) || empty, 'drop');
  return { key: card.dataset.key, t: empty.dataset.t, over, drop };
})()`);
check('D1 dragover on the slot text is accepted', r.over === true, r);
check('D2 drop on the slot text is blocked from the browser', r.drop === true, r);
await P.waitFor(`!!document.querySelector("#slots .slot[data-t='${r.t}'].filled")`);
check('D3 the card lands in that slot', !!(await P.count("#slots .slot[data-t='" + r.t + "'].filled")), r);
const stray = await P.js(`(() => { const dt = new DataTransfer();
  const card = document.querySelector('#lib-list .lib-card[draggable=true]');
  card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
  const e = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }); document.querySelector('#lib-list').dispatchEvent(e);
  card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt })); return e.defaultPrevented; })()`);
check('D4 dropping a card back on the Database is blocked too', stray === true);
P.close();
process.exit(summary());
