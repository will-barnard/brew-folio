// Display helpers. Money arrives as integer cents and is never floated for math.

export function splitMoney(cents, { sign = 'auto' } = {}) {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  const c = String(abs % 100).padStart(2, '0');
  let s = '';
  if (sign === 'always') s = neg ? '−' : '+';
  else if (sign === 'auto' && neg) s = '−';
  return { sign: s, dollars, cents: c, neg };
}

export const money = (cents, opts) => {
  const m = splitMoney(cents, opts);
  return `${m.sign}$${m.dollars}.${m.cents}`;
};

// "12.50" / "12" / "-3.2" → cents, or null.
export function parseCents(input) {
  const s = String(input ?? '').replace(/[$,\s]/g, '');
  if (!/^-?\d*(\.\d{0,2})?$/.test(s) || s === '' || s === '-' || s === '.') return null;
  const neg = s.startsWith('-');
  const [w, f = ''] = s.replace('-', '').split('.');
  const cents = Number(w || 0) * 100 + Number((f + '00').slice(0, 2));
  return neg ? -cents : cents;
}

const dayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const shortFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const monthFmt = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const monthOnly = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' });

// Dates are 'YYYY-MM-DD' calendar days; format them in UTC so they never shift.
const d = (iso) => new Date(`${iso}T00:00:00Z`);
export const dayLabel = (iso) => dayFmt.format(d(iso));
export const shortDate = (iso) => shortFmt.format(d(iso));
export const monthLabel = (ym) => monthFmt.format(d(`${ym}-01`));
export const monthName = (ym) => monthOnly.format(d(`${ym}-01`));

export function todayISO() {
  const n = new Date();
  return new Date(n.getTime() - n.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + delta, 1));
  return dt.toISOString().slice(0, 7);
}

export function ago(ts) {
  if (!ts) return 'never';
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export const KIND_LABEL = {
  checking: 'Checking', savings: 'Savings', credit: 'Credit card', brokerage: 'Brokerage', retirement: 'Retirement',
  exchange: 'Crypto exchange', wallet: 'Crypto wallet', cash: 'Cash', clearing: 'Clearing', asset: 'Asset', loan: 'Loan',
};
