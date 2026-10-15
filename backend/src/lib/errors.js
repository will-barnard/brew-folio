// Errors carry a status and a message a caller can act on.
class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    if (extra) Object.assign(this, { extra });
  }
}

const badRequest = (msg, extra) => new HttpError(400, msg, extra);
const unauthorized = (msg = 'Sign in required', extra) => new HttpError(401, msg, extra);
const forbidden = (msg = 'Not allowed') => new HttpError(403, msg);
const notFound = (what = 'Not found') => new HttpError(404, what);
const conflict = (msg, extra) => new HttpError(409, msg, extra);
const tooLarge = (msg) => new HttpError(413, msg);
const unprocessable = (msg, extra) => new HttpError(422, msg, extra);
// Scaffolded-but-deferred features return this rather than a plausible fake.
const notImplemented = (msg) => new HttpError(501, msg);

module.exports = {
  HttpError, badRequest, unauthorized, forbidden, notFound, conflict, tooLarge, unprocessable, notImplemented,
};
