// Admin sign-in for the EternaWell site.
//
// The password is the ADMIN_PASSWORD environment variable (Netlify: Site configuration -> Environment
// variables). If it is not set, the password is "admin" — the site works straight after deploying, with no
// configuration. Set ADMIN_PASSWORD in Netlify to change it; nothing needs to be redeployed.
//
// Signing in sets a cookie holding an expiry time and an HMAC of it, keyed on the password. Changing the
// password therefore signs everyone out, and the cookie cannot be forged without knowing the password.

import { COOKIE, SESSION_HOURS, b64url, subtle, timingSafeEqual } from './core.mjs';

export const DEFAULT_PASSWORD = 'admin';
export const adminPassword = (env) => env.ADMIN_PASSWORD || DEFAULT_PASSWORD;

async function hmacKey(env) {
  const raw = new TextEncoder().encode(`${adminPassword(env)}|eternawell-session`);
  return subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function makeSession(env) {
  const exp = Date.now() + SESSION_HOURS * 3600e3;
  const sig = await subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(`admin.${exp}`));
  return `${exp}.${b64url(sig)}`;
}

export async function isAdmin(request, env) {
  const m = (request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = await subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(`admin.${exp}`));
  return b64url(expected) === sig;
}

export async function passwordMatches(given, env) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([subtle.digest('SHA-256', enc.encode(String(given))), subtle.digest('SHA-256', enc.encode(adminPassword(env)))]);
  return timingSafeEqual(a, b);
}

// Secure is fine on Netlify (every site is served over https) and keeps the cookie off plain http.
export const sessionCookie = (value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
