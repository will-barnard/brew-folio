// Small input coercers that throw 400s with a useful message.
const { badRequest } = require('./errors');
const { isISODate } = require('./dates');
const { toCents } = require('./money');

const optional = (v) => v === undefined;

function int(v, name, { min = 1, nullable = false } = {}) {
  if ((v === null || v === '') && nullable) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw badRequest(`${name} must be an integer`);
  return n;
}

function str(v, name, { max = 500, nullable = false, min = 0 } = {}) {
  if ((v === null || v === undefined || v === '') && nullable) return null;
  if (typeof v !== 'string') throw badRequest(`${name} must be text`);
  const s = v.trim();
  if (s.length < min) throw badRequest(`${name} is required`);
  if (s.length > max) throw badRequest(`${name} is too long (max ${max})`);
  return s;
}

function date(v, name) {
  if (!isISODate(v)) throw badRequest(`${name} must be YYYY-MM-DD`);
  return v;
}

// Accepts integer cents (amount_cents) or a decimal string/number (amount).
function cents(body, { required = true } = {}) {
  if (body.amount_cents !== undefined) {
    if (!Number.isInteger(body.amount_cents)) throw badRequest('amount_cents must be an integer');
    return body.amount_cents;
  }
  if (body.amount !== undefined) {
    const c = toCents(body.amount);
    if (c === null) throw badRequest('amount is not a number');
    return c;
  }
  if (required) throw badRequest('amount is required');
  return undefined;
}

function oneOf(v, name, values) {
  if (!values.includes(v)) throw badRequest(`${name} must be one of ${values.join(', ')}`);
  return v;
}

module.exports = { optional, int, str, date, cents, oneOf };
