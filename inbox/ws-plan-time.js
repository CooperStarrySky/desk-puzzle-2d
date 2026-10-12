/* Puzzle workspace: release times. Puzzles go live on US Eastern time
   (America/New_York), whatever time zone the planner's own computer is in.
   A release is stored as an exact moment (timestamptz); these helpers turn
   "Thu Oct 15, 6:00 AM ET" into that moment and back. Weeks start on Monday. */
const TZ = 'America/New_York';
const FMT = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n) => (n < 10 ? '0' : '') + n;

/* The Eastern wall clock at a moment: { y, m, d, h, mi, date: 'YYYY-MM-DD', time: 'HH:MM' }. */
export function etParts(when) {
  const ms = when instanceof Date ? when.getTime() : new Date(when).getTime();
  const o = {}; FMT.formatToParts(new Date(ms)).forEach((x) => { o[x.type] = Number(x.value); });
  const r = { y: o.year, m: o.month, d: o.day, h: o.hour % 24, mi: o.minute };
  r.date = r.y + '-' + p2(r.m) + '-' + p2(r.d); r.time = p2(r.h) + ':' + p2(r.mi);
  return r;
}
/* "2026-10-15" + "06:00" Eastern -> ISO moment (handles daylight saving). */
export function etToIso(date, time) {
  const [y, m, d] = String(date).split('-').map(Number), [h, mi] = String(time || '06:00').split(':').map(Number);
  if (!y || !m || !d || isNaN(h) || isNaN(mi)) return null;
  const want = Date.UTC(y, m - 1, d, h, mi);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const e = etParts(guess), shown = Date.UTC(e.y, e.m - 1, e.d, e.h, e.mi);
    if (shown === want) break;
    guess += want - shown;
  }
  return new Date(guess).toISOString();
}
/* Day of the week of an Eastern calendar date (0 = Sunday). */
function dow(date) { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number), x = new Date(Date.UTC(y, m - 1, d + n));
  return x.getUTCFullYear() + '-' + p2(x.getUTCMonth() + 1) + '-' + p2(x.getUTCDate());
}
export const todayEt = () => etParts(Date.now()).date;
/* The next Thursday after today (Eastern), as YYYY-MM-DD. */
export function nextThursday(from) {
  const t = from || todayEt(), n = (11 - dow(t)) % 7 || 7;
  return addDays(t, n);
}
/* Monday of the week holding this Eastern date (or moment). */
export function weekOf(dateOrIso) {
  const date = /T/.test(String(dateOrIso)) ? etParts(dateOrIso).date : String(dateOrIso).slice(0, 10);
  return addDays(date, -((dow(date) + 6) % 7));
}
export function dayLabel(date, withYear) {
  const [y, m, d] = date.split('-').map(Number);
  return DAYS[dow(date)] + ' ' + MONTHS[m - 1] + ' ' + d + (withYear ? ', ' + y : '');
}
/* "Thu Oct 15, 6:00 AM ET" for a stored release moment. */
export function releaseLabel(iso) {
  if (!iso) return '';
  const e = etParts(iso);
  return dayLabel(e.date) + ', ' + ((e.h + 11) % 12 + 1) + ':' + p2(e.mi) + (e.h < 12 ? ' AM' : ' PM') + ' ET';
}
export function shortDay(date) { const [, m, d] = date.split('-').map(Number); return MONTHS[m - 1] + ' ' + d; }
