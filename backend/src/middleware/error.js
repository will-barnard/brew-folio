// Final error handler. 4xx carry their message to the client; 5xx are logged
// and returned without internals.
function errorHandler(err, req, res, _next) {
  let status = err.status || err.statusCode || 500;
  // body-parser errors
  if (err.type === 'entity.parse.failed') status = 400;
  if (err.type === 'entity.too.large') status = 413;
  // Postgres constraint violations the routes didn't anticipate.
  if (err.code === '23505') status = 409;
  if (err.code === '23503') status = 409;
  if (err.code === '23514' || err.code === '22P02') status = 400;

  if (status >= 500 && status !== 501) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  }
  if (res.headersSent) return;
  const body = { error: status >= 500 && !err.expose ? 'Internal error' : err.message };
  if (err.extra) Object.assign(body, err.extra);
  if (status === 501) body.error = err.message;
  res.status(status).json(body);
}

module.exports = { errorHandler };
