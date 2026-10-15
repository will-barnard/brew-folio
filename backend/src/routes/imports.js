// Statement / export uploads. The upload route takes the raw file as the
// request body (X-Filename header) and is registered BEFORE the JSON parser —
// a body parser would consume the stream.
const express = require('express');
const { query } = require('../db/pool');
const { int } = require('../lib/validate');
const { notFound } = require('../lib/errors');
const { receiveUpload } = require('../services/uploads');
const { createBatch, getBatch, commitBatch, undoBatch } = require('../services/imports');
const storage = require('../services/storage');

const router = express.Router();

router.post('/imports', async (req, res) => {
  const up = await receiveUpload(req);
  try {
    const accountId = req.query.account_id ? int(req.query.account_id, 'account_id') : null;
    const { batches } = await createBatch(up, { origin: 'web', accountId });
    // First batch is the response; any others (consolidated statements) are listed as siblings.
    res.status(201).json(batches[0]);
  } finally {
    await up.cleanup();
  }
});

// Scoped per-route: a router-level parser would also see requests passing
// through on their way to other routers' upload routes.
const json = express.json({ limit: '32kb' });

router.get('/imports', async (_req, res) => {
  const { rows } = await query(
    `SELECT b.id, b.origin, b.kind, b.parser, b.filename, b.status, b.account_id, a.name AS account_name,
            b.detected_last4, b.detected_kind, b.period_start, b.period_end, b.reconciled, b.stats, b.warnings,
            b.error, b.created_at, b.imported_at,
            jsonb_array_length(COALESCE(b.parsed->'transactions', '[]'::jsonb)) AS row_count
       FROM import_batches b LEFT JOIN accounts a ON a.id = b.account_id
      ORDER BY b.created_at DESC LIMIT 200`);
  res.json(rows);
});

router.get('/imports/:id', async (req, res) => {
  res.json(await getBatch(int(req.params.id, 'id')));
});

router.post('/imports/:id/commit', json, async (req, res) => {
  const stats = await commitBatch(int(req.params.id, 'id'), {
    accountId: req.body?.account_id ? int(req.body.account_id, 'account_id') : null,
    force: Boolean(req.body?.force),
    actor: req.actor,
  });
  res.json({ stats });
});

router.delete('/imports/:id', async (req, res) => {
  res.json(await undoBatch(int(req.params.id, 'id'), { actor: req.actor }));
});

// The original file, decrypted — for "show me the statement".
router.get('/imports/:id/file', async (req, res) => {
  const { rows: [b] } = await query('SELECT filename, mime, storage_key FROM import_batches WHERE id = $1', [int(req.params.id, 'id')]);
  if (!b || !b.storage_key) throw notFound('File not found');
  const buf = await storage.getFile(b.storage_key);
  res.setHeader('Content-Type', b.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${(b.filename || 'statement').replace(/"/g, '')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(buf);
});

module.exports = router;
