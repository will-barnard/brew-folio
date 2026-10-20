// Express app. Mount order matters:
//   1. /healthz            — process-only, no DB (a slow query must not fail a deploy)
//   2. /api/auth           — public login/bootstrap + session-gated account routes
//   3. /api/v1             — API-key only (machines)
//   4. /api               — session + CSRF header for everything else
// No global body parser: upload routes stream the raw body, so each router
// mounts express.json() itself, after any upload route.
const express = require('express');
const { requireSession, requireCsrf } = require('./middleware/auth');
const { errorHandler } = require('./middleware/error');
const { notFound } = require('./lib/errors');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Requests arrive via nginx-proxy then the frontend nginx; trust both hops for req.ip.
  app.set('trust proxy', 2);

  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/api/healthz', (_req, res) => res.json({ ok: true }));

  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/v1', require('./routes/machine'));

  const api = express.Router();
  api.use(requireSession, requireCsrf);
  // Routers with raw-body upload routes first; each handles its own JSON parsing.
  api.use(require('./routes/imports'));
  api.use(require('./routes/transactions'));
  api.use(express.json({ limit: '256kb' }));
  api.use(require('./routes/reference'));
  api.use(require('./routes/accounts'));
  api.use(require('./routes/review'));
  api.use(require('./routes/rules'));
  api.use(require('./routes/reports'));
  api.use(require('./routes/portfolio'));
  api.use(require('./routes/settings'));
  app.use('/api', api);

  app.use('/api', (_req, _res, next) => next(notFound('No such endpoint')));
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
