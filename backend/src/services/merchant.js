// Turns bank descriptors into a merchant name a person would recognise:
//   "Card Purchase 09/15 Sq *Blue Bottle Coffee Chicago IL Card 1234" → "Blue Bottle Coffee"
//   "ORIG CO NAME:STRIPE ORIG ID:1800948598 DESC DATE:..."           → "Stripe"
//   "Zelle Payment From Jane Doe 12345678"                           → "Zelle · Jane Doe"
// Deterministic and conservative: when unsure, keep more text. Phase 2 lets
// dry-dock clean up whatever this misses.

const LEADING = [
  /^\d{2}\/\d{2}\s+/,                          // statement rows that repeat the date
  /^(recurring\s+)?card purchase( with pin)?( return)?\s+\d{2}\/\d{2}\s+/i,
  /^(pos\s+)?(debit\s+)?(card\s+)?purchase( authorized)?( on)?\s+\d{2}\/\d{2}\s+/i,
  /^atm (withdrawal|cash deposit)\s+\d{2}\/\d{2}\s+/i,
  /^(sq|tst|sp|py|dd|ic|pp|bt|pos|cke|par)\s*\*\s*/i,
  /^paypal\s*\*\s*/i,
];

// Merchants whose descriptors vary too much to clean generically.
const KNOWN = [
  [/^(amzn|amazon)(\s*(mktp|mktplace|marketplace|\.com|prime))?(\s*us)?\b/i, 'Amazon'],
  [/^google\s*\*?\s*cloud/i, 'Google Cloud'],
  [/^google\s*\*?\s*(gsuite|workspace)/i, 'Google Workspace'],
  [/^wholefds/i, 'Whole Foods'],
];

const TRAILING = [
  /\s+card\s+\d{4}$/i,
  /\s+\d{3}[-.]?\d{3}[-.]?\d{4}$/,           // phone numbers
  /\s+(#|no\.?\s*)\d+$/i,                    // store numbers
  // City just before a state code: "… CHICAGO IL". One word only — two would
  // eat "Coffee" out of "Blue Bottle Coffee Chicago IL".
  /\s+[A-Z][A-Za-z.]+\s+[A-Z]{2}$/,
  /\s+[A-Z]{2}\s*$/,                          // state code (case-sensitive: real states are caps)
  /\s+\d{4,}$/,                               // trailing reference numbers
  /\s+[a-z0-9]{10,}$/i,                       // trailing auth codes
  /\s+(?=[a-z]*\d)[a-z0-9]{5,}$/i,            // trailing token with digits in it ("4X9ZQP")
  /\s+(ppd|ccd|web|tel)\s+id:?.*$/i,          // ACH entry class tails
];

const ACRONYMS = new Set(['ATM', 'ACH', 'USA', 'LLC', 'IRS', 'USPS', 'UPS', 'CVS', 'BP', 'IKEA', 'AWS', 'GCP', 'HBO', 'NYT', 'AT&T', 'TJ', 'DMV']);

function titleCase(s) {
  return s.toLowerCase().replace(/\b([a-z0-9&'.]+)/g, (w) => {
    const up = w.toUpperCase();
    if (ACRONYMS.has(up)) return up;
    return w.charAt(0).toUpperCase() + w.slice(1);
  });
}

function normalizeMerchant(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/\s+/g, ' ').trim();

  // ACH lines carry the counterparty in a labelled field.
  const ach = s.match(/ORIG CO NAME:\s*(.+?)\s+(ORIG ID|DESC DATE|CO ENTRY|SEC:|IND ID)/i);
  if (ach) return titleCase(ach[1].trim());

  const zelle = s.match(/^Zelle (Payment|Transfer) (To|From)\s+(.+?)(\s+\S*\d\S*)?$/i);
  if (zelle) return `Zelle · ${titleCase(zelle[3].trim())}`;

  if (/^(online )?transfer (to|from)/i.test(s)) return titleCase(s.replace(/\s+(#|transaction#:?)\s*\S+.*$/i, ''));

  for (const re of LEADING) s = s.replace(re, '');
  for (const [re, name] of KNOWN) if (re.test(s)) return name;
  let prev;
  do {
    prev = s;
    for (const re of TRAILING) {
      const next = s.replace(re, '').trim();
      if (next.length >= 3) s = next; // never strip a name down to nothing
    }
  } while (s !== prev);

  s = s.replace(/[*#]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return titleCase(String(raw).trim().slice(0, 60));
  return titleCase(s).slice(0, 80);
}

module.exports = { normalizeMerchant };
