// Two credentials, never interchangeable:
//  - the session cookie (a human in the app), checked by requireSession
//  - an API key (iOS Shortcuts, other brew apps), checked by requireApiKey
const { query } = require('../db/pool');
const { sha256, safeEqualHex } = require('../lib/crypto');
const { unauthorized, forbidden } = require('../lib/errors');
const config = require('../config');

const COOKIE = 'folio_session';
const DAY = 86_400_000;

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieHeader(value, maxAgeSec) {
  return [
    `${COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    config.cookieSecure ? 'Secure' : null,
    `Max-Age=${maxAgeSec}`,
  ].filter(Boolean).join('; ');
}

async function requireSession(req, _res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return next(unauthorized());
  const { rows } = await query(
    `SELECT s.id AS session_id, s.last_seen_at, u.id, u.username, u.totp_enabled, u.is_admin
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
  if (!rows.length) return next(unauthorized('Session expired — sign in again'));
  const u = rows[0];
  // Sliding expiry, written at most once a day so reads stay cheap.
  if (Date.now() - new Date(u.last_seen_at).getTime() > DAY) {
    query(`UPDATE sessions SET last_seen_at = now(), expires_at = now() + ($2 || ' days')::interval WHERE id = $1`,
      [u.session_id, String(config.sessionDays)]).catch(() => {});
  }
  req.user = { id: u.id, username: u.username, totpEnabled: u.totp_enabled, isAdmin: u.is_admin, sessionId: u.session_id };
  req.actor = `user:${u.username}`;
  next();
}

// CSRF: the cookie is SameSite=Lax, and every state-changing request from the
// app also sends X-Folio: 1 — a custom header a cross-site form can't set.
function requireCsrf(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-folio') !== '1') return next(forbidden('Missing X-Folio header'));
  next();
}

// Keys look like fk_<prefix>_<secret>. Only sha256(full key) is stored.
function requireApiKey(scope) {
  return async (req, _res, next) => {
    const raw = req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const m = /^fk_([a-z0-9]{8})_([A-Za-z0-9_-]{20,})$/.exec(raw || '');
    if (!m) return next(unauthorized('Missing or malformed API key'));
    const { rows } = await query(
      'SELECT id, name, key_hash, scopes, last_used_at FROM api_keys WHERE prefix = $1 AND revoked_at IS NULL',
      [m[1]],
    );
    const key = rows[0];
    if (!key || !safeEqualHex(key.key_hash, sha256(raw))) return next(unauthorized('Invalid API key'));
    if (scope && !key.scopes.includes(scope)) return next(forbidden(`API key lacks scope ${scope}`));
    if (!key.last_used_at || Date.now() - new Date(key.last_used_at).getTime() > 60_000) {
      query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [key.id]).catch(() => {});
    }
    req.apiKey = { id: key.id, name: key.name, scopes: key.scopes };
    req.actor = `key:${key.name}`;
    next();
  };
}

module.exports = { COOKIE, parseCookies, cookieHeader, requireSession, requireCsrf, requireApiKey };
