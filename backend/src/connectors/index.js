// Connector registry.
//
// File parsers turn an uploaded file into normalized rows; sync connectors
// (Phase 2+) pull from an API on a schedule. Both feed services/ingest.js,
// which owns dedupe, transfers and rules — connectors never write the ledger.
//
// Normalized transaction: { posted_on 'YYYY-MM-DD', amount_cents (signed; − = out),
//   description_raw, external_id (stable per account+source), meta {} }
const fsp = require('fs/promises');
const chaseCsv = require('./chase-csv');
const chasePdf = require('./chase-pdf');
const fidelity = require('./fidelity');
const { unprocessable } = require('../lib/errors');

// Always resolves to an array: one parsed result per account in the file
// (a consolidated Chase statement covers checking and savings together).
async function parseFile({ path, filename, mime }) {
  const head = Buffer.alloc(5);
  const fh = await fsp.open(path, 'r');
  try { await fh.read(head, 0, 5, 0); } finally { await fh.close(); }

  if (head.toString('latin1') === '%PDF-') {
    const text = await chasePdf.extractText(path);
    if (fidelity.sniffPdf(text)) return fidelity.parseStatementText(text);
    return chasePdf.parseText(text);
  }
  const looksText = /csv|text|excel|octet-stream/i.test(mime) || /\.(csv|txt)$/i.test(filename);
  if (looksText) {
    const text = await fsp.readFile(path, 'utf8');
    if (chaseCsv.sniff(text)) return [chaseCsv.parse(text, { filename })];
    if (fidelity.sniffCsv(text)) return fidelity.parseCsvText(text, { filename });
    if (/^OFXHEADER|<OFX>/i.test(text.slice(0, 500))) {
      throw unprocessable('QFX/OFX import isn’t built yet — export CSV from Chase instead');
    }
  }
  throw unprocessable('Unrecognised file. Supported now: Chase activity CSV and statement PDFs (checking, savings, cards, auto loans), Fidelity statement PDFs and Positions CSV.');
}

// Sync connectors, scaffolded so the UI can show what's coming. Each returns
// 501 from /api/connectors/:id/sync until its phase lands.
const planned = [
  { id: 'simplefin', name: 'SimpleFIN Bridge', phase: 2, covers: 'Chase checking + cards, brokerages — nightly' },
  { id: 'stripe', name: 'Stripe', phase: 3, covers: 'Dev revenue, fees, payouts' },
  { id: 'gcp-billing', name: 'Google Cloud billing (BigQuery export)', phase: 3, covers: 'Hosting cost detail per project' },
  { id: 'paypal', name: 'PayPal', phase: 3, covers: 'Music income' },
  { id: 'venmo-csv', name: 'Venmo CSV', phase: 3, covers: 'Monthly statement upload' },
  { id: 'gear-tracker', name: 'gear-tracker', phase: 4, covers: 'Instrument valuations — needs its API' },
  { id: 'seedbook', name: 'Seedbook', phase: 5, covers: 'Open proposals → expected income' },
];

const available = [
  { id: 'chase-csv', name: 'Chase activity CSV', phase: 1, covers: 'Checking + cards, any date range' },
  { id: 'chase-pdf', name: 'Chase statement PDF', phase: 1, covers: 'Checking, savings, cards and auto loans, with balance reconciliation' },
  { id: 'fidelity', name: 'Fidelity statement PDF / Positions CSV', phase: 2, covers: 'Brokerage and Roth IRA holdings' },
  { id: 'positions', name: 'Manual positions', phase: 2, covers: 'Coinbase or anything else — quantities you enter, valued at live prices' },
  { id: 'manual', name: 'Manual / quick add', phase: 0, covers: 'Cash, checks, anything' },
];

module.exports = { parseFile, planned, available };
