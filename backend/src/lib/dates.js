// Calendar dates as 'YYYY-MM-DD' strings. A ledger cares about the day the
// bank says, not an instant, so we avoid Date objects for stored values.
const config = require('../config');

// Today in the configured timezone (Chicago by default).
function today(tz = config.tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

function hourIn(tz = config.tz) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' })
    .format(new Date()));
}

function isISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function diffDays(a, b) {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

// 'MM/DD/YYYY' or 'MM/DD/YY' → ISO
function fromUS(s) {
  const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  const iso = `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return isISODate(iso) ? iso : null;
}

// A statement line gives 'MM/DD' with no year. Pick the year that lands the
// date inside (or within a week of) the statement period — handles the
// December→January statement that spans two years.
function resolveMonthDay(md, periodStart, periodEnd) {
  const m = String(md).match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!m || !periodStart || !periodEnd) return null;
  const years = new Set([periodStart.slice(0, 4), periodEnd.slice(0, 4)]);
  let best = null;
  for (const y of years) {
    const iso = `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    if (!isISODate(iso)) continue;
    const dist = iso < periodStart ? diffDays(periodStart, iso) : iso > periodEnd ? diffDays(iso, periodEnd) : 0;
    if (best === null || dist < best.dist) best = { iso, dist };
  }
  return best && best.dist <= 7 ? best.iso : null;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// 'September 14, 2026' → ISO
function fromLong(s) {
  const m = String(s).trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[1].toLowerCase());
  if (mi === -1) return null;
  const iso = `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return isISODate(iso) ? iso : null;
}

function monthBounds(ym) {
  const [y, m] = ym.split('-').map(Number);
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { start, end: addDays(next, -1) };
}

module.exports = { today, hourIn, isISODate, addDays, diffDays, fromUS, fromLong, resolveMonthDay, monthBounds };
