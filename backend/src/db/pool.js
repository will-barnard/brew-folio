const { Pool, types } = require('pg');
const config = require('../config');

// int8 → Number. Money is stored as integer cents in bigint; Number is exact
// up to 2^53 cents (~90 trillion dollars), which is plenty. Also makes
// COUNT(*) come back as a number instead of a string.
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
// date → keep the 'YYYY-MM-DD' string. Parsing to a JS Date shifts the day
// in any timezone west of UTC, which for a ledger means wrong-month totals.
types.setTypeParser(1082, (v) => v);

const pool = new Pool({ ...config.db, max: 10 });

pool.on('error', (err) => {
  // An idle client dying (postgres restart) shouldn't take the process down.
  console.error('[db] idle client error', err.message);
});

async function query(text, params) {
  return pool.query(text, params);
}

// Run fn inside a transaction. fn receives a client with .query.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, tx };
