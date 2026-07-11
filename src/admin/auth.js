// Admin authentication for the settings UI: password login -> HMAC-signed session cookie.
// No external dependency — signing/verification uses node:crypto.
import crypto from 'node:crypto';
import { bootConfig } from '../config.js';

const COOKIE = 'cf_admin';
const TTL_MS = 12 * 60 * 60 * 1000; // 12h

function signingKey() {
  return bootConfig.secretKey || bootConfig.adminPassword || 'insecure-dev-key';
}

function hmac(data) {
  return crypto.createHmac('sha256', signingKey()).update(data).digest('base64url');
}

function timingEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** True if admin auth is effectively disabled (dev with no password set). */
export function adminOpen() {
  return !bootConfig.adminPassword;
}

/** Verify a submitted password against ADMIN_PASSWORD (constant-time). */
export function checkPassword(password) {
  if (adminOpen()) return true;
  return timingEqual(password || '', bootConfig.adminPassword);
}

/** Issue a signed session token. */
export function issueToken() {
  const exp = Date.now() + TTL_MS;
  return `${exp}.${hmac(String(exp))}`;
}

/** Verify a session token: signature valid AND not expired. */
export function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!timingEqual(sig, hmac(exp))) return false;
  return Number(exp) > Date.now();
}

/** Build the Set-Cookie header value for the session. */
export function sessionCookie(token) {
  const secure = bootConfig.isProduction ? '; Secure' : '';
  return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${TTL_MS / 1000}${secure}`;
}

export function clearCookie() {
  return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function readCookie(req) {
  const raw = req.headers?.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return '';
}

/** Express middleware guarding /admin* routes. */
export function requireAdmin(req, res, next) {
  if (adminOpen()) return next(); // dev-only: no password configured
  const token = readCookie(req) || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (verifyToken(token)) return next();
  // API calls get JSON 401; page navigations get redirected to login.
  // (Mounted middleware sees a mount-relative req.path, so use originalUrl.)
  if ((req.originalUrl || '').includes('/admin/api')) return res.status(401).json({ error: 'unauthorized' });
  return res.redirect('/admin/login');
}
