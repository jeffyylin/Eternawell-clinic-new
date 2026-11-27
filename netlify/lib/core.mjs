// Shared logic for the EternaWell Netlify functions: time and date maths for the clinic's time zone,
// settings validation, and the Google / Apple / iCal calendar readers.
//
// This is the same code that ran in the Cloudflare Worker (worker/index.js), with three changes:
//  - secrets come from process.env (Netlify: Site configuration -> Environment variables), not Worker secrets,
//  - Web Crypto is taken from node:crypto so it works on every Node version Netlify runs,
//  - the "please add this secret" messages name Netlify instead of Cloudflare.
// Nothing here touches storage; that is netlify/lib/store.mjs.

import { webcrypto, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';

const wc = globalThis.crypto && globalThis.crypto.subtle ? globalThis.crypto : webcrypto;

export const TZ = 'America/Los_Angeles';
export const SESSION_HOURS = 12;
export const COOKIE = 'ew_admin';
export const MAX_MEDIA_BYTES = 1_900_000; // kept from the Cloudflare version: comfortably under Netlify's body limit
export const MODES = ['in-person', 'telemedicine'];

export const DEFAULT_SETTINGS = {
  clinic: { phone: '(206) 507-2504', address1: '2700 Richards Rd, Suite 204A', address2: 'Bellevue, WA 98005' },
  visitTypes: [
    { id: 'consult', name: 'Free 20-minute consultation', name_zh: '免费 20 分钟咨询', minutes: 20, active: true },
    { id: 'initial', name: 'Lab draw & full initial consultation', name_zh: '抽血化验及完整初诊', minutes: 60, active: true },
    { id: 'followup', name: 'Follow-up visit', name_zh: '复诊', minutes: 30, active: true },
  ],
  // 0 = Sunday … 6 = Saturday; null = closed
  hours: [null, { start: '09:00', end: '17:00' }, { start: '09:00', end: '17:00' }, { start: '09:00', end: '17:00' }, { start: '09:00', end: '17:00' }, { start: '09:00', end: '17:00' }, null],
  slotStep: 30,
  bufferMinutes: 0,
  minNoticeHours: 12,
  maxDaysAhead: 60,
  blockedDates: [], // e.g. the doctor's EZCall work days
  blockedTimes: [], // part of a day: { date: 'YYYY-MM-DD', start: 'HH:MM', end: 'HH:MM' }
  retentionDays: 365, // past and cancelled bookings older than this are deleted
  // Google Calendar: the calendar is shared with the service account in GOOGLE_SERVICE_ACCOUNT_KEY
  google: { calendars: [], bookingCalendar: '', detail: 'minimal' },
  // Apple Calendar: read with the APPLE_ID and APPLE_APP_PASSWORD variables
  apple: { calendars: [], bookingCalendar: '' },
  // Calendar links (iCal feeds), e.g. EZCall shifts the doctor subscribes to. Read only.
  feeds: [],
};

// ---------- small helpers ----------
// Patient-facing messages in Chinese (the API gets the page language in the x-lang header)
const ZH = {
  'Please choose a visit type.': '请选择就诊类型。',
  'Please choose a date and time.': '请选择日期和时间。',
  'Please choose in person or telemedicine.': '请选择到诊或远程视频就诊。',
  'Please enter your name.': '请填写您的姓名。',
  'Please enter a phone number we can reach you at.': '请填写可以联系到您的电话号码。',
  'Please check your email address.': '请检查您的电子邮箱地址。',
  'Please enter your email address.': '请填写您的电子邮箱地址。',
  'Sorry, that time was just taken. Please choose another.': '抱歉，这个时间刚刚被预约了，请选择其他时间。',
  'Please confirm the consent box to book.': '请勾选同意框后再预约。',
  'Too many bookings from this connection. Please call or text us.': '此网络的预约次数过多，请致电或发短信联系我们。',
  'Booking not found.': '找不到该预约。',
  'This booking could not be cancelled. Please call or text us.': '无法取消该预约，请致电或发短信联系我们。',
  'Something went wrong. Please try again, or call or text us.': '出了点问题，请重试，或致电、发短信联系我们。',
  'Please enter an email address or phone number so we can reply.': '请填写电子邮箱或电话号码，以便我们回复您。',
  'Please write a message.': '请填写留言内容。',
  'Please confirm the consent box to send your message.': '请勾选同意框后再发送留言。',
  'Too many messages from this connection. Please call or text us.': '此网络发送的留言过多，请致电或发短信联系我们。',
};
export const tr = (lang, msg) => (String(lang || '').startsWith('zh') && ZH[msg]) || msg;

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
export const bad = (msg, status = 400) => json({ error: msg }, status);

export const hm = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
export const dayNum = (date) => { const [y, m, d] = date.split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
export const dateOf = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
export const weekday = (date) => new Date(dayNum(date) * 864e5).getUTCDay();
export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(dayNum(s));
export const isHM = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

// Clinic wall-clock time (date and minutes after midnight) for a moment in time
export function laParts(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: (+p.hour % 24) * 60 + +p.minute };
}
export const nowLA = () => laParts(Date.now());
export const absMin = (date, min) => dayNum(date) * 1440 + min; // minutes since 1970 on the clinic's wall clock

export const randomHex = (bytes) => [...wc.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
export const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const subtle = wc.subtle;

// Cloudflare had crypto.subtle.timingSafeEqual; on Node it lives in node:crypto and needs equal lengths
// (always true here: both sides are SHA-256 digests).
export function timingSafeEqual(a, b) {
  const x = Buffer.from(a instanceof ArrayBuffer ? a : a.buffer || a);
  const y = Buffer.from(b instanceof ArrayBuffer ? b : b.buffer || b);
  return x.length === y.length && nodeTimingSafeEqual(x, y);
}

// Keeps only simple inline formatting in edited text: no scripts, styles or event handlers.
export function sanitizeHtml(html) {
  const allowed = { b: [], strong: [], i: [], em: [], br: [], span: ['class', 'data-set'], a: ['href', 'class', 'target', 'rel'] };
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed|template)[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?([a-zA-Z0-9-]+)([^>]*)>/g, (tag, name, attrs) => {
      name = name.toLowerCase();
      if (!(name in allowed)) return '';
      if (tag.startsWith('</')) return `</${name}>`;
      let out = '';
      for (const m of attrs.matchAll(/([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
        const key = m[1].toLowerCase();
        const val = m[3] ?? m[4] ?? '';
        if (!allowed[name].includes(key)) continue;
        if (key === 'href' && !/^(https?:|tel:|sms:|mailto:|\/|#)/i.test(val.trim())) continue;
        out += ` ${key}="${val.replace(/"/g, '&quot;')}"`;
      }
      return `<${name}${out}>`;
    });
}

export function cleanSettings(input) {
  const s = structuredClone(DEFAULT_SETTINGS);
  if (!input || typeof input !== 'object') return s;
  if (input.clinic) {
    for (const k of ['phone', 'address1', 'address2']) {
      if (typeof input.clinic[k] === 'string') s.clinic[k] = input.clinic[k].trim().slice(0, 120);
    }
  }
  if (Array.isArray(input.visitTypes)) {
    const seen = new Set();
    s.visitTypes = input.visitTypes.slice(0, 20).map((t) => ({
      id: String(t.id || '').replace(/[^a-z0-9-]/gi, '').slice(0, 32) || randomHex(4),
      name: String(t.name || '').trim().slice(0, 80),
      name_zh: String(t.name_zh || '').trim().slice(0, 80),
      minutes: Math.min(480, Math.max(5, Math.round(Number(t.minutes) || 30))),
      active: t.active !== false,
    })).filter((t) => t.name && !seen.has(t.id) && seen.add(t.id));
  }
  if (Array.isArray(input.hours) && input.hours.length === 7) {
    s.hours = input.hours.map((h) => (h && isHM(h.start) && isHM(h.end) && hm(h.end) > hm(h.start) ? { start: h.start, end: h.end } : null));
  }
  const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);
  s.slotStep = num(input.slotStep, 5, 240, s.slotStep);
  s.bufferMinutes = num(input.bufferMinutes, 0, 120, s.bufferMinutes);
  s.minNoticeHours = num(input.minNoticeHours, 0, 24 * 14, s.minNoticeHours);
  s.maxDaysAhead = num(input.maxDaysAhead, 1, 365, s.maxDaysAhead);
  s.retentionDays = num(input.retentionDays, 30, 3650, s.retentionDays);
  if (Array.isArray(input.blockedDates)) s.blockedDates = [...new Set(input.blockedDates.filter(isDate))].sort().slice(-1000);
  if (Array.isArray(input.blockedTimes)) {
    const seen = new Set();
    s.blockedTimes = input.blockedTimes
      .filter((b) => b && isDate(b.date) && isHM(b.start) && isHM(b.end) && hm(b.end) > hm(b.start))
      .map((b) => ({ date: b.date, start: b.start, end: b.end }))
      .filter((b) => { const k = `${b.date} ${b.start} ${b.end}`; return !seen.has(k) && seen.add(k); })
      .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))
      .slice(-2000);
  }
  if (input.google && typeof input.google === 'object') {
    const g = input.google;
    const okId = (v) => { const id = String(v || '').trim().slice(0, 300); return /^[^\s"'<>]+$/.test(id) ? id : ''; };
    // Settings saved before multiple calendars had a single calendarId
    let cals = Array.isArray(g.calendars) ? g.calendars : g.calendarId ? [{ id: g.calendarId, label: '', busy: g.blockBusy === true }] : [];
    const seen = new Set();
    cals = cals.slice(0, 10)
      .map((c) => {
        const k = (c && c.block) || {};
        return { id: okId(c && c.id), label: String((c && c.label) || '').trim().slice(0, 60), busy: !!(c && c.busy), block: { busy: k.busy !== false, free: k.free !== false, allDay: k.allDay !== false } };
      })
      .filter((c) => c.id && !seen.has(c.id) && seen.add(c.id));
    let booking = 'bookingCalendar' in g ? okId(g.bookingCalendar) : g.calendarId && g.addEvents !== false ? okId(g.calendarId) : '';
    if (!cals.some((c) => c.id === booking)) booking = '';
    s.google = { calendars: cals, bookingCalendar: booking, detail: g.detail === 'full' ? 'full' : 'minimal' };
  }
  if (input.apple && typeof input.apple === 'object') {
    const a = input.apple;
    const okUrl = (v) => { const u = String(v || '').trim().slice(0, 500); return /^https?:\/\/[^\s"'<>]+$/.test(u) ? u : ''; };
    const seen = new Set();
    const cals = (Array.isArray(a.calendars) ? a.calendars : []).slice(0, 20)
      .map((c) => {
        const k = (c && c.block) || {};
        return { url: okUrl(c && c.url), label: String((c && c.label) || '').trim().slice(0, 60), busy: !!(c && c.busy), block: { busy: k.busy !== false, free: k.free !== false, allDay: k.allDay !== false } };
      })
      .filter((c) => c.url && !seen.has(c.url) && seen.add(c.url));
    const booking = okUrl(a.bookingCalendar);
    s.apple = { calendars: cals, bookingCalendar: cals.some((c) => c.url === booking) ? booking : '' };
  }
  if (Array.isArray(input.feeds)) {
    const seen = new Set();
    s.feeds = input.feeds.slice(0, 10)
      .map((f) => {
        const k = (f && f.block) || {};
        return { url: feedUrl(f && f.url), label: String((f && f.label) || '').trim().slice(0, 60), block: { busy: k.busy !== false, free: k.free !== false, allDay: k.allDay !== false } };
      })
      .filter((f) => f.url && !seen.has(f.url) && seen.add(f.url));
  }
  return s;
}

// ---------- Google Calendar ----------
// The GOOGLE_SERVICE_ACCOUNT_KEY variable holds the service account's JSON key file. The doctor shares their
// calendar with the service account's email ("Make changes to events") and enters the calendar ID in the admin.
const GOOGLE_API = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
let googleToken = null; // { value, exp, email } cached per function instance

export function serviceAccount(env) {
  try {
    const k = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_KEY || '');
    return k.client_email && k.private_key ? k : null;
  } catch {
    return null;
  }
}

async function googleAccessToken(env) {
  const sa = serviceAccount(env);
  if (!sa) throw new Error('The Google service account key has not been added to Netlify yet (environment variable GOOGLE_SERVICE_ACCOUNT_KEY).');
  if (googleToken && googleToken.email === sa.client_email && googleToken.exp > Date.now() + 60e3) return googleToken.value;
  const tokenUrl = env.GOOGLE_TOKEN_URL || GOOGLE_TOKEN;
  const now = Math.floor(Date.now() / 1000);
  const part = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/calendar', aud: tokenUrl, iat: now, exp: now + 3600 })}`;
  const der = Uint8Array.from(atob(sa.private_key.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  const key = await subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(sig)}` }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) throw new Error(`Google rejected the service account key (${d.error_description || d.error || res.status}).`);
  googleToken = { value: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000, email: sa.client_email };
  return d.access_token;
}

export async function gcal(env, method, path, body) {
  const res = await fetch((env.GOOGLE_API_BASE || GOOGLE_API) + path, {
    method,
    headers: { authorization: `Bearer ${await googleAccessToken(env)}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (method === 'DELETE' && [204, 404, 410].includes(res.status)) return {}; // deleted, or already gone
  const d = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error((d.error && d.error.message) || `Google Calendar error ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return d;
}

export const calPath = (id) => `/calendars/${encodeURIComponent(id)}`;
const localIso = (abs) => `${dateOf(Math.floor(abs / 1440))}T${String(Math.floor((abs % 1440) / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}:00`;

// The calendar event for a booking. "minimal" keeps patient contact details out of Google.
export function eventFor(b, detail, origin) {
  const mode = b.mode === 'telemedicine' ? 'Telemedicine' : 'In person';
  const initials = b.name.split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase() + '.').join('');
  const full = detail === 'full';
  const lines = full
    ? [`Patient: ${b.name}`, `Phone: ${b.phone}`, b.email && `Email: ${b.email}`, `Visit: ${mode}`, b.note && `Note: ${b.note}`]
    : [`Patient: ${initials}`, `Visit: ${mode}`, 'Full details are in the admin, not in the calendar.'];
  const start = absMin(b.date, b.start);
  return {
    summary: `${b.type_name} – ${full ? b.name : initials} (${mode})`,
    description: [...lines, '', `Booked through the EternaWell website. Admin: ${origin}/admin/`].filter((l) => l !== false && l !== undefined && l !== '').join('\n'),
    start: { dateTime: localIso(start), timeZone: TZ },
    end: { dateTime: localIso(start + b.minutes), timeZone: TZ },
    location: b.mode === 'telemedicine' ? 'Telemedicine' : undefined,
    extendedProperties: { private: { eternawellBooking: b.id } },
    reminders: { useDefault: true },
  };
}

// ---------- Apple Calendar (iCloud, over CalDAV) ----------
// The APPLE_ID variable is the doctor's Apple ID email and APPLE_APP_PASSWORD an app-specific password made at
// appleid.apple.com. They are only ever sent to iCloud (APPLE_CALDAV_URL exists only for local testing).
const APPLE_CALDAV = 'https://caldav.icloud.com/';

export function appleAccount(env) {
  const id = String(env.APPLE_ID || '').trim();
  const pass = String(env.APPLE_APP_PASSWORD || '').trim();
  return id && pass ? { id, pass } : null;
}

function appleHostOk(env, url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'https:' && (u.hostname === 'icloud.com' || u.hostname.endsWith('.icloud.com'))) return true;
  return !!env.APPLE_CALDAV_URL && u.origin === new URL(env.APPLE_CALDAV_URL).origin;
}

// One CalDAV request. Follows iCloud's redirects to the server that holds the account.
export async function dav(env, method, url, body, headers = {}) {
  const acct = appleAccount(env);
  if (!acct) throw new Error('The Apple ID and app-specific password have not been added to Netlify yet (environment variables APPLE_ID and APPLE_APP_PASSWORD).');
  const auth = `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(`${acct.id}:${acct.pass}`)))}`;
  for (let hop = 0; hop < 4; hop++) {
    if (!appleHostOk(env, url)) throw new Error("That isn't an iCloud calendar address.");
    const res = await fetch(url, { method, redirect: 'manual', body, headers: { authorization: auth, ...headers } });
    const to = res.headers.get('location');
    if ([301, 302, 307, 308].includes(res.status) && to) { url = new URL(to, url).href; continue; }
    if (res.status === 401) { const e = new Error('iCloud rejected the Apple ID or app-specific password. Make a new app-specific password and update the APPLE_APP_PASSWORD variable.'); e.status = 401; throw e; }
    if (method === 'DELETE' && [200, 204, 404, 410].includes(res.status)) return { text: '', url };
    const text = await res.text();
    if (!res.ok) { const e = new Error(`iCloud error ${res.status}`); e.status = res.status; throw e; }
    return { text, url };
  }
  throw new Error('iCloud redirected too many times.');
}

export const XML = { 'content-type': 'application/xml; charset=utf-8' };
export const DAV_NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"';
export const propfind = (env, url, depth, props) => dav(env, 'PROPFIND', url, `<?xml version="1.0" encoding="utf-8"?><d:propfind ${DAV_NS}><d:prop>${props}</d:prop></d:propfind>`, { ...XML, depth: String(depth) });
export const APPLE_CALDAV_BASE = APPLE_CALDAV;

// A small reader for CalDAV's XML replies: the <response> blocks, and the text of a tag inside one
// (whatever namespace prefix the server uses).
export const xmlText = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;'))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
export const xmlBlocks = (xml, tag) => [...xml.matchAll(new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>)`, 'gi'))].map((m) => m[1] || '');
export const xmlTag = (xml, tag) => { const b = xmlBlocks(xml, tag); return b.length ? xmlText(b[0]).trim() : ''; };

// Clinic-independent time-zone maths for calendar files: wall-clock time in a zone <-> a moment in time
const zoneFormats = new Map();
function zoneOffset(ms, tz) {
  let f = zoneFormats.get(tz);
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }); } catch { f = null; }
    zoneFormats.set(tz, f);
  }
  if (!f) return null;
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, +x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
function zonedMs(wall, tz) { // wall: the wall-clock time written as if it were UTC
  if (zoneOffset(0, tz) === null) tz = TZ; // unknown zone names (e.g. from Outlook) count as clinic time
  let t = wall - zoneOffset(wall, tz);
  t = wall - zoneOffset(t, tz);
  return t;
}

// ---- calendar files (iCalendar, RFC 5545) ----
function icsProps(block) {
  return block.split(/\r?\n/).filter(Boolean).map((line) => {
    const i = line.search(/[:;]/);
    if (i < 0) return null;
    const name = line.slice(0, i).toUpperCase();
    const params = {};
    let rest = line.slice(i);
    while (rest[0] === ';') {
      const m = rest.match(/^;([^=;:]+)=("[^"]*"|[^;:]*)/);
      if (!m) break;
      params[m[1].toUpperCase()] = m[2].replace(/^"|"$/g, '');
      rest = rest.slice(m[0].length);
    }
    return { name, params, value: rest.slice(1) };
  }).filter(Boolean);
}

// A DTSTART/DTEND value as { date } (all day) or { wall, tz } (wall-clock ms in a zone; tz '' = UTC)
function icsTime(p) {
  if (!p) return null;
  const m = p.value.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  if (!m[4] || p.params.VALUE === 'DATE') return { date: `${m[1]}-${m[2]}-${m[3]}` };
  return { wall: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]), tz: m[7] ? '' : p.params.TZID || TZ };
}
const icsMs = (t) => (t.tz ? zonedMs(t.wall, t.tz) : t.wall);
function icsDuration(v) {
  const m = String(v || '').match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * ((+m[2] || 0) * 7 * 864e5 + (+m[3] || 0) * 864e5 + (+m[4] || 0) * 36e5 + (+m[5] || 0) * 6e4 + (+m[6] || 0) * 1e3);
}

// The events in a calendar-query reply, with repeating events expanded between two moments, as
// { start, end, kind } where start/end are clinic minute ranges like the Google ones.
export function icsEvents(text, fromMs, toMs, me) {
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const vevents = [...unfolded.matchAll(/BEGIN:VEVENT\r?\n([\s\S]*?)END:VEVENT/g)].map((m) => {
    const props = icsProps(m[1]);
    const one = (n) => props.find((p) => p.name === n);
    return { props, one, uid: (one('UID') || {}).value || '', rid: icsTime(one('RECURRENCE-ID')) };
  });
  const key = (t) => (t.date ? t.date : String(icsMs(t)));
  const overridden = new Set(vevents.filter((v) => v.rid).map((v) => `${v.uid}|${key(v.rid)}`));
  const out = [];
  for (const v of vevents) {
    if (/^CANCELLED$/i.test((v.one('STATUS') || {}).value || '')) continue;
    const attendee = me && v.props.find((p) => p.name === 'ATTENDEE' && p.value.toLowerCase() === `mailto:${me.toLowerCase()}`);
    if (attendee && attendee.params.PARTSTAT === 'DECLINED') continue;
    const start = icsTime(v.one('DTSTART'));
    if (!start) continue;
    const end = icsTime(v.one('DTEND'));
    const kind = start.date ? 'allDay' : /^TRANSPARENT$/i.test((v.one('TRANSP') || {}).value || '') ? 'free' : 'busy';
    // length of the event: whole days for all-day events, milliseconds otherwise
    const len = start.date
      ? (end && end.date ? dayNum(end.date) - dayNum(start.date) : Math.max(1, Math.round(icsDuration((v.one('DURATION') || {}).value) / 864e5) || 1))
      : (end && !end.date ? icsMs(end) - icsMs(start) : icsDuration((v.one('DURATION') || {}).value));
    if (len <= 0) continue;
    const rrule = v.rid ? null : v.one('RRULE');
    const skip = new Set();
    for (const p of v.props.filter((x) => x.name === 'EXDATE')) {
      for (const val of p.value.split(',')) { const t = icsTime({ value: val, params: p.params }); if (t) skip.add(key(start.date && !t.date ? { date: dateOf(Math.floor(t.wall / 864e5)) } : t)); }
    }
    const starts = rrule ? icsRepeat(start, rrule.value, toMs) : [start];
    for (const s of starts) {
      if (rrule && (skip.has(key(s)) || overridden.has(`${v.uid}|${key(s)}`))) continue;
      let a, b;
      if (s.date) { a = absMin(s.date, 0); b = a + len * 1440; } else {
        const ms = icsMs(s);
        const pa = laParts(ms), pb = laParts(ms + len);
        a = absMin(pa.date, pa.min); b = absMin(pb.date, pb.min);
      }
      const aMs = s.date ? zonedMs(dayNum(s.date) * 864e5, TZ) : icsMs(s);
      if (aMs >= toMs || aMs + (s.date ? len * 864e5 : len) <= fromMs) continue;
      out.push({ start: a, end: b, kind });
    }
  }
  return out;
}

// The start times of a repeating event up to a moment, for the common rules (daily, weekly, monthly,
// yearly, with INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY and BYMONTH). iCloud normally expands repeats
// itself, so this is only a fallback.
function icsRepeat(start, rule, toMs) {
  const r = Object.fromEntries(rule.split(';').map((x) => x.split('=')).map(([k, v]) => [k.toUpperCase(), v || '']));
  const freq = r.FREQ;
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return [start];
  const every = Math.max(1, +r.INTERVAL || 1);
  const count = +r.COUNT || Infinity;
  const until = r.UNTIL ? icsTime({ value: r.UNTIL, params: {} }) : null;
  const untilMs = until ? (until.date ? zonedMs((dayNum(until.date) + 1) * 864e5, TZ) - 1 : icsMs(until)) : Infinity;
  const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const byDay = (r.BYDAY || '').split(',').filter(Boolean).map((x) => { const m = x.match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/i); return m && { n: +m[1] || 0, wd: DAYS.indexOf(m[2].toUpperCase()) }; }).filter(Boolean);
  const byMonthDay = (r.BYMONTHDAY || '').split(',').filter(Boolean).map(Number);
  const byMonth = (r.BYMONTH || '').split(',').filter(Boolean).map(Number);
  const d0 = start.date ? dayNum(start.date) : Math.floor(start.wall / 864e5);
  const tod = start.date ? 0 : start.wall - d0 * 864e5;
  const day0 = new Date(d0 * 864e5);
  const wkst = DAYS.indexOf((r.WKST || 'MO').toUpperCase());
  const weekOf = (d) => Math.floor((d - ((new Date(d * 864e5).getUTCDay() - wkst + 7) % 7) - d0 + ((day0.getUTCDay() - wkst + 7) % 7)) / 7);
  const matches = (d) => {
    const dt = new Date(d * 864e5);
    const y = dt.getUTCFullYear(), mo = dt.getUTCMonth(), md = dt.getUTCDate(), wd = dt.getUTCDay();
    const months = (y - day0.getUTCFullYear()) * 12 + mo - day0.getUTCMonth();
    const inMonth = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    const nth = (b) => b.wd === wd && (!b.n || (b.n > 0 ? Math.ceil(md / 7) === b.n : Math.ceil((inMonth - md + 1) / 7) === -b.n));
    if (byMonth.length && !byMonth.includes(mo + 1)) return false;
    if (freq === 'DAILY') return (d - d0) % every === 0 && (!byDay.length || byDay.some((b) => b.wd === wd));
    if (freq === 'WEEKLY') return weekOf(d) % every === 0 && (byDay.length ? byDay.some((b) => b.wd === wd) : wd === day0.getUTCDay());
    if (freq === 'MONTHLY') {
      if (months % every) return false;
      if (byDay.length) return byDay.some(nth);
      if (byMonthDay.length) return byMonthDay.some((x) => (x > 0 ? x : inMonth + x + 1) === md);
      return md === day0.getUTCDate();
    }
    if ((y - day0.getUTCFullYear()) % every) return false;
    if (byDay.length && byMonth.length) return byDay.some(nth);
    return mo === day0.getUTCMonth() && md === day0.getUTCDate();
  };
  const out = [];
  let n = 0;
  for (let d = d0; d < d0 + 40000 && n < count; d++) {
    const s = start.date ? { date: dateOf(d) } : { wall: d * 864e5 + tod, tz: start.tz };
    const ms = start.date ? zonedMs(d * 864e5, TZ) : icsMs(s);
    if (ms > untilMs || ms >= toMs) break;
    if (d !== d0 && !matches(d)) continue;
    n++;
    out.push(s);
  }
  return out;
}

// A booking as a calendar file for iCloud (times in UTC, so no time-zone block is needed). Apple doesn't
// sign HIPAA agreements, so these events always use the minimal details.
export function icsFor(b, origin) {
  const ev = eventFor(b, 'minimal', origin);
  const start = absMin(b.date, b.start);
  const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const esc = (t) => String(t).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const fold = (line) => { // lines of at most 75 bytes
    let out = '', len = 0;
    for (const ch of line) {
      const n = new TextEncoder().encode(ch).length;
      if (len + n > 74) { out += '\r\n '; len = 1; }
      out += ch; len += n;
    }
    return out;
  };
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//EternaWell Medicine//Booking//EN', 'BEGIN:VEVENT',
    `UID:eternawell-${b.id}@eternawell`, `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(zonedMs(start * 6e4, TZ))}`, `DTEND:${stamp(zonedMs((start + b.minutes) * 6e4, TZ))}`,
    `SUMMARY:${esc(ev.summary)}`, `DESCRIPTION:${esc(ev.description)}`, ev.location && `LOCATION:${esc(ev.location)}`,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].filter((l) => l !== undefined).map(fold).join('\r\n');
}

// ---------- calendar links (iCal feeds) ----------
// A calendar link as pasted (webcal:// links are https), or '' if it isn't a web address
export function feedUrl(v) {
  const u = String(v || '').trim().replace(/^webcals?:\/\//i, 'https://').slice(0, 1000);
  return /^https?:\/\/[^\s"'<>]+$/i.test(u) ? u : '';
}

export async function fetchFeed(url) {
  const res = await fetch(url, { headers: { accept: 'text/calendar, */*' }, redirect: 'follow' });
  if (!res.ok) { const e = new Error(`The calendar link answered with error ${res.status}.`); e.status = res.status; throw e; }
  const text = await res.text();
  if (text.length > 10_000_000) throw new Error('That calendar is too large to read (over 10 MB).');
  if (!/BEGIN:VCALENDAR/.test(text)) throw new Error("That link isn't a calendar file (iCal). Check it's the calendar's subscribe / iCal link.");
  return text;
}
