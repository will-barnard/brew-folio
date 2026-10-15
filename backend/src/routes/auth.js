// Single-owner auth: the first account created becomes admin and registration
// closes. Optional TOTP second factor. Sessions are random tokens in an
// HttpOnly cookie; only their sha256 is stored.
const express = require('express');
const { query, tx } = require('../db/pool');
const {
  hashPassword, verifyPassword, randomToken, sha256,
  encryptString, decryptString, totpSecret, verifyTotp,
} = require('../lib/crypto');
const { badRequest, unauthorized, conflict, HttpError } = require('../lib/errors');
const { cookieHeader, requireSession, requireCsrf } = require('../middleware/auth');
const { audit } = require('../services/audit');
const config = require('../config');

const router = express.Router();
router.use(express.json({ limit: '32kb' }));

// ── login throttling (in-process; single backend replica) ───────────────
const attempts = new Map();
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 10;
function throttle(req) {
  const key = req.ip;
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.resetAt < now) { attempts.set(key, { n: 1, resetAt: now + WINDOW_MS }); return; }
  a.n += 1;
  if (a.n > MAX_ATTEMPTS) throw new HttpError(429, 'Too many sign-in attempts — wait 15 minutes');
}

async function startSession(res, userId, req) {
  const token = randomToken(32);
  await query(
    `INSERT INTO sessions (user_id, token_hash, user_agent, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' days')::interval)`,
    [userId, sha256(token), (req.get('user-agent') || '').slice(0, 300), String(config.sessionDays)],
  );
  res.setHeader('Set-Cookie', cookieHeader(token, config.sessionDays * 86400));
}

function validateCredentials(username, password) {
  if (!username || !/^[a-zA-Z0-9_.-]{2,40}$/.test(username)) throw badRequest('Username: 2–40 letters, numbers, . _ -');
  if (!password || password.length < 10) throw badRequest('Password must be at least 10 characters');
}

router.get('/state', async (_req, res) => {
  const { rows } = await query('SELECT count(*) AS n FROM users');
  res.json({ bootstrapped: rows[0].n > 0 });
});

// First account becomes admin. Closed once any user exists.
router.post('/bootstrap', async (req, res) => {
  const { username, password } = req.body || {};
  validateCredentials(username, password);
  const user = await tx(async (db) => {
    // Lock so two simultaneous first-visits can't both become admin.
    await db.query('LOCK TABLE users IN EXCLUSIVE MODE');
    const { rows } = await db.query('SELECT count(*) AS n FROM users');
    if (rows[0].n > 0) throw conflict('Already set up — sign in instead');
    const ins = await db.query(
      'INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, true) RETURNING id, username',
      [username, hashPassword(password)],
    );
    await audit(db, { actor: `user:${username}`, action: 'bootstrap', entity: 'user', entityId: ins.rows[0].id });
    return ins.rows[0];
  });
  await startSession(res, user.id, req);
  res.status(201).json({ user: { username: user.username, totpEnabled: false } });
});

router.post('/login', async (req, res) => {
  throttle(req);
  const { username, password, code } = req.body || {};
  if (!username || !password) throw badRequest('Username and password required');
  const { rows } = await query('SELECT * FROM users WHERE username = $1', [username]);
  const u = rows[0];
  // Same message for unknown user and bad password.
  if (!u || !verifyPassword(password, u.password_hash)) throw unauthorized('Wrong username or password');
  if (u.totp_enabled) {
    if (!code) throw unauthorized('Enter your authenticator code', { totpRequired: true });
    const step = verifyTotp(decryptString(u.totp_secret_enc), code);
    if (step === null || (u.totp_last_step && step <= Number(u.totp_last_step))) {
      throw unauthorized('That code didn’t work — wait for the next one', { totpRequired: true });
    }
    await query('UPDATE users SET totp_last_step = $2 WHERE id = $1', [u.id, step]);
  }
  attempts.delete(req.ip);
  await startSession(res, u.id, req);
  res.json({ user: { username: u.username, totpEnabled: u.totp_enabled } });
});

router.post('/logout', requireSession, requireCsrf, async (req, res) => {
  await query('DELETE FROM sessions WHERE id = $1', [req.user.sessionId]);
  res.setHeader('Set-Cookie', cookieHeader('', 0));
  res.json({ ok: true });
});

router.get('/me', requireSession, (req, res) => {
  res.json({ user: { username: req.user.username, totpEnabled: req.user.totpEnabled } });
});

router.post('/password', requireSession, requireCsrf, async (req, res) => {
  const { current, next } = req.body || {};
  const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!verifyPassword(current || '', rows[0].password_hash)) throw unauthorized('Current password is wrong');
  validateCredentials(req.user.username, next);
  await tx(async (db) => {
    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user.id, hashPassword(next)]);
    // Sign out every other device.
    await db.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [req.user.id, req.user.sessionId]);
    await audit(db, { actor: req.actor, action: 'password_change', entity: 'user', entityId: req.user.id });
  });
  res.json({ ok: true });
});

// TOTP enrolment is two steps so a typo in the authenticator can't lock you out:
// setup stores a pending secret; enable requires a valid code from it.
router.post('/totp/setup', requireSession, requireCsrf, async (req, res) => {
  if (req.user.totpEnabled) throw conflict('Two-factor is already on');
  const secret = totpSecret();
  await query('UPDATE users SET totp_secret_enc = $2 WHERE id = $1', [req.user.id, encryptString(secret)]);
  const label = encodeURIComponent(`folio:${req.user.username}`);
  res.json({
    secret,
    otpauth: `otpauth://totp/${label}?secret=${secret}&issuer=folio&algorithm=SHA1&digits=6&period=30`,
  });
});

router.post('/totp/enable', requireSession, requireCsrf, async (req, res) => {
  const { rows } = await query('SELECT totp_secret_enc FROM users WHERE id = $1', [req.user.id]);
  if (!rows[0].totp_secret_enc) throw badRequest('Start setup first');
  const step = verifyTotp(decryptString(rows[0].totp_secret_enc), req.body?.code);
  if (step === null) throw badRequest('Code didn’t match — check the time on your phone and try the next one');
  await tx(async (db) => {
    await db.query('UPDATE users SET totp_enabled = true, totp_last_step = $2 WHERE id = $1', [req.user.id, step]);
    await audit(db, { actor: req.actor, action: 'totp_enable', entity: 'user', entityId: req.user.id });
  });
  res.json({ ok: true });
});

router.post('/totp/disable', requireSession, requireCsrf, async (req, res) => {
  const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!verifyPassword(req.body?.password || '', rows[0].password_hash)) throw unauthorized('Password is wrong');
  await tx(async (db) => {
    await db.query('UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, totp_last_step = NULL WHERE id = $1', [req.user.id]);
    await audit(db, { actor: req.actor, action: 'totp_disable', entity: 'user', entityId: req.user.id });
  });
  res.json({ ok: true });
});

module.exports = router;
