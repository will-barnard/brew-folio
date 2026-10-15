process.env.FOLIO_ENC_KEY = '2'.repeat(64);
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');
const c = require('../src/lib/crypto');
const { normalizeMerchant } = require('../src/services/merchant');
const { compile, validateMatch } = require('../src/services/rules');
const { looksLikeTransfer } = require('../src/services/transfers');
const { similarity } = require('../src/services/ingest');
const { parseCsv } = require('../src/lib/csv');

test('password hash round trip', () => {
  const h = c.hashPassword('correct horse battery');
  assert.ok(c.verifyPassword('correct horse battery', h));
  assert.ok(!c.verifyPassword('wrong', h));
});

test('string secret round trip', () => {
  const enc = c.encryptString('sfin-access-url');
  assert.match(enc, /^v1:/);
  assert.equal(c.decryptString(enc), 'sfin-access-url');
});

test('file encryption round trip (streaming encrypt, buffered decrypt)', async () => {
  const plain = Buffer.from('x'.repeat(100_000));
  const chunks = [];
  await new Promise((res, rej) => Readable.from([plain.subarray(0, 40_000), plain.subarray(40_000)])
    .pipe(c.createEncryptStream()).on('data', (d) => chunks.push(d)).on('end', res).on('error', rej));
  const enc = Buffer.concat(chunks);
  assert.ok(!enc.includes(Buffer.from('xxxxxxxx')));
  assert.deepEqual(c.decryptFileBuffer(enc), plain);
  enc[30] ^= 1; // tamper
  assert.throws(() => c.decryptFileBuffer(enc));
});

test('TOTP matches RFC 6238 vector', () => {
  // RFC 6238 SHA-1 secret "12345678901234567890", T=59 → 94287082 (8 digits) → last 6: 287082
  const secret = c.base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(c.totpAt(secret, 1), '287082');
  assert.equal(c.verifyTotp(secret, '287082', { now: 59_000 }), 1);
  assert.equal(c.verifyTotp(secret, '000000', { now: 59_000 }), null);
});

test('merchant normalization', () => {
  assert.equal(normalizeMerchant('Card Purchase 10/09 Sq *Blue Bottle Coffee Chicago IL Card 1234'), 'Blue Bottle Coffee');
  assert.equal(normalizeMerchant('ORIG CO NAME:STRIPE ORIG ID:1800948598 DESC DATE:261003'), 'Stripe');
  assert.equal(normalizeMerchant('Zelle Payment From Jane Doe 21837465'), 'Zelle · Jane Doe');
  assert.equal(normalizeMerchant('SPOTIFY USA'), 'Spotify USA');
  assert.equal(normalizeMerchant('WHOLEFDS LPK 10232'), 'Whole Foods');
  assert.equal(normalizeMerchant('AMAZON MKTP US*2K4L1'), 'Amazon');
  assert.equal(normalizeMerchant('GOOGLE *CLOUD 4X9ZQP'), 'Google Cloud');
  assert.equal(normalizeMerchant('ACME CORP PAYROLL PPD ID: 9988776655'), 'Acme Corp Payroll');
  assert.equal(normalizeMerchant('NETFLIX.COM 866-579-7172 CA'), 'Netflix.com');
  assert.equal(normalizeMerchant('TRADER JOE\'S #552 CHICAGO IL'), 'Trader Joe\'s');
});

test('rules match', () => {
  const t = { account_id: 1, amount_cents: -8712, description_raw: 'GOOGLE *CLOUD 4X9ZQP', merchant: 'Google Cloud' };
  assert.ok(compile({ match: { contains: 'google *cloud' } })(t));
  assert.ok(compile({ match: { merchant: 'google cloud', direction: 'out' } })(t));
  assert.ok(!compile({ match: { merchant: 'google cloud', direction: 'in' } })(t));
  assert.ok(compile({ match: { regex: '^GOOGLE', min_cents: 5000, max_cents: 10000 } })(t));
  assert.throws(() => validateMatch({}), /must match on something/);
  assert.throws(() => validateMatch({ regex: '(' }), /compile/);
});

test('transfer patterns', () => {
  assert.ok(looksLikeTransfer({ description_raw: 'Payment Thank You-Mobile', meta: {} }));
  assert.ok(looksLikeTransfer({ description_raw: 'whatever', meta: { type: 'ACCT_XFER' } }));
  assert.ok(!looksLikeTransfer({ description_raw: 'Zelle Payment From Jane Doe', meta: {} }));
});

test('description similarity for cross-source dedupe', () => {
  assert.ok(similarity('ORIG CO NAME:STRIPE ORIG ID:1800948598', 'Orig CO Name:Stripe Orig ID:1800948598 Desc') > 0.5);
  assert.ok(similarity('Blue Bottle Coffee', 'Shell Oil') < 0.34);
});

test('csv parser handles quotes, commas and CRLF', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","he said ""hi"""\r\n'), [['a', 'b'], ['x, y', 'he said "hi"']]);
});
