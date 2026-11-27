// Storage for the EternaWell site, on Netlify Blobs.
//
// The Cloudflare version kept everything in one SQLite-backed Durable Object. Netlify has no equivalent, so
// each table becomes one JSON document in a Blobs store ("eternawell"), and uploaded photos become one blob
// each in a second store ("eternawell-media"):
//
//   settings    the doctor's settings (one object, same shape as before)
//   content     the website text and photo edits: { key: { v, updated } }
//   bookings    every booking, as an array of the rows the old bookings table held
//   messages    the "Send the doctor a message" form's messages
//   hits        the rate-limit counters
//   cal-status  the last result of talking to Google / iCloud / a calendar link
//   apple-home  where iCloud said this account's calendars live
//
// ---- one thing is weaker here than it was on Cloudflare ----
// A Durable Object handled one request at a time, so "check the slot is free, then insert the booking" could
// not be interleaved with another request: double-booking was impossible.
//
// Netlify Blobs has no compare-and-swap or conditional write (checked against @netlify/blobs v8: set() takes
// only { metadata } and returns nothing), so that guarantee cannot be reproduced exactly. What mutate() does
// instead is write and then read back: if another request wrote the same document at the same moment, we see
// a version that is not ours and redo the change on top of theirs — which re-runs the slot check, so the
// second patient is told the time has gone.
//
// That closes every interleaving except one: if two bookings are written within the same read-back (a few
// tens of milliseconds of each other), the first can still be overwritten and lost, and the patient will
// have been told it was confirmed. For a clinic booking a handful of appointments a day the chance is very
// small, and the doctor sees the result in the admin. If it ever needs to be airtight, bookings need a store
// with real transactions — the simplest route is to keep the Cloudflare Worker for /api/ only, or to put the
// bookings table in a small SQL database (Neon, Turso, Supabase) and leave everything else here.

import { getStore } from '@netlify/blobs';
import {
  DEFAULT_SETTINGS, MODES, TZ, absMin, appleAccount, calPath, cleanSettings, dateOf, dayNum, eventFor, dav,
  fetchFeed, feedUrl, gcal, hm, icsEvents, icsFor, isDate, laParts, nowLA, propfind, randomHex, serviceAccount,
  weekday, xmlBlocks, xmlTag, xmlText, APPLE_CALDAV_BASE, DAV_NS, XML,
} from './core.mjs';

const data = () => getStore({ name: 'eternawell', consistency: 'strong' });
const mediaStore = () => getStore({ name: 'eternawell-media', consistency: 'strong' });

// Caches that used to live on the Durable Object instance. They now live per function instance, which has the
// same effect: a short-lived cache that several requests in a row can share.
const busyCache = new Map(); // "from|to" -> { at, ranges }
const feedCache = new Map(); // calendar link -> { at, text }

async function read(key, fallback) {
  const v = await data().get(key, { type: 'json' }).catch(() => null);
  return v == null ? structuredClone(fallback) : v;
}

// Read a document, change it, write it back, then read it back again to check our change is the one that
// stuck. Netlify Blobs has no compare-and-swap, so this read-back is the only way to notice that another
// request wrote the same document at the same moment; when that happens, fn runs again on top of the other
// request's version instead of our change being silently lost.
//
// fn(current, out) returns the new document, or undefined to write nothing (a booking whose slot has gone, a
// rate-limited request, an id that does not exist). Whatever it puts on out.value is returned to the caller.
// fn must be safe to run more than once: callers that add a record build it first and only append it if it is
// not already there.
//
// The one case this cannot catch is two writes landing inside the same read-back (a few tens of
// milliseconds). See the note at the top of this file.
const ATTEMPTS = 10;
const SETTLE_MS = 70; // long enough to cover a write that started just before our read-back
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function mutate(key, fallback, fn, { settle = true } = {}) {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const store = data();
    const out = {};
    const next = await fn(await read(key, fallback), out);
    if (next === undefined) return out.value; // nothing to write, so nothing to race over
    const wanted = JSON.stringify(next);
    await store.setJSON(key, next);

    // Check ours is the live version. Reading twice, with a pause, also catches a write that was already on
    // its way when we read the first time — the window that would otherwise lose our change silently.
    let live = JSON.stringify(await store.get(key, { type: 'json' }).catch(() => null)) === wanted;
    if (live && settle) {
      await sleep(SETTLE_MS);
      live = JSON.stringify(await store.get(key, { type: 'json' }).catch(() => null)) === wanted;
    }
    if (live) return out.value;

    // Somebody else wrote at the same moment. Wait longer after each clash, by an amount that differs between
    // requests, so a group of simultaneous writes spreads out instead of clashing again in step. fn then runs
    // again on top of their version, so both changes end up kept.
    await sleep(Math.min(400, 12 * 2 ** attempt) + Math.floor(Math.random() * 40));
  }
  throw new Error('The site is busy saving another change. Please try again.');
}

export class Store {
  constructor(env) {
    this.env = env;
  }

  // ---- settings ----
  async getSettings() {
    return cleanSettings(await read('settings', DEFAULT_SETTINGS));
  }

  async saveSettings(input) {
    const s = cleanSettings(input);
    await data().setJSON('settings', s);
    return s;
  }

  // ---- website text and photos ----
  // { key: value } for the page renderer
  async getContent() {
    const all = await read('content', {});
    const out = {};
    for (const [k, r] of Object.entries(all)) out[k] = r.v;
    return out;
  }

  // Newest first, for the admin's list of edits
  async getContentList() {
    const all = await read('content', {});
    return Object.entries(all)
      .map(([k, r]) => ({ k, v: r.v, updated: r.updated }))
      .sort((a, b) => b.updated - a.updated);
  }

  async saveContent(changes) {
    const now = Date.now();
    return mutate('content', {}, (all, out) => {
      for (const [k, v] of Object.entries(changes)) {
        if (v === null) delete all[k];
        else all[k] = { v, updated: now };
      }
      const flat = {};
      for (const [k, r] of Object.entries(all)) flat[k] = r.v;
      out.value = flat;
      return all;
    });
  }

  // ---- uploaded photos ----
  async putMedia(type, bytes) {
    const id = randomHex(12);
    await mediaStore().set(id, bytes, { metadata: { type, created: Date.now() } });
    return id;
  }

  async getMedia(id) {
    const got = await mediaStore().getWithMetadata(id, { type: 'arrayBuffer' }).catch(() => null);
    if (!got || got.data == null) return null;
    return { type: (got.metadata && got.metadata.type) || 'application/octet-stream', data: got.data };
  }

  // ---- rate limiting ----
  // Allows `limit` calls per `windowSec` for a key (an IP address and action).
  async hit(key, limit, windowSec) {
    const now = Date.now();
    return mutate('hits', [], (hits, out) => {
      const kept = hits.filter((h) => h.t >= now - windowSec * 1000);
      if (kept.filter((h) => h.k === key).length >= limit) {
        out.value = false;
        return undefined; // over the limit: refuse without writing
      }
      kept.push({ k: key, t: now });
      out.value = true;
      return kept.slice(-5000);
      // No settle pause: this runs on every request, and an occasional miscount of a rate limit does not
      // matter the way a lost booking would.
    }, { settle: false });
  }

  // ---- bookings ----
  async allBookings() {
    return read('bookings', []);
  }

  async takenOn(from, to) {
    const all = await this.allBookings();
    return all.filter((b) => b.date >= from && b.date <= to && ['confirmed', 'completed'].includes(b.status))
      .map((b) => ({ date: b.date, start: b.start, minutes: b.minutes }));
  }

  slots(settings, type, date, taken, calBusy = []) {
    if (!isDate(date)) return [];
    const h = settings.hours[weekday(date)];
    if (!h || settings.blockedDates.includes(date)) return [];
    const now = nowLA();
    const today = dayNum(now.date);
    const d = dayNum(date);
    if (d < today || d > today + settings.maxDaysAhead) return [];
    const earliest = today * 1440 + now.min + settings.minNoticeHours * 60;
    const busy = taken.filter((b) => b.date === date)
      .map((b) => [absMin(b.date, b.start) - settings.bufferMinutes, absMin(b.date, b.start) + b.minutes + settings.bufferMinutes])
      .concat(settings.blockedTimes.filter((b) => b.date === date).map((b) => [absMin(date, hm(b.start)), absMin(date, hm(b.end))]))
      .concat(calBusy);
    const out = [];
    for (let t = hm(h.start); t + type.minutes <= hm(h.end); t += settings.slotStep) {
      const at = d * 1440 + t;
      if (at < earliest) continue;
      if (busy.some(([a, b]) => at < b && at + type.minutes > a)) continue;
      out.push(t);
    }
    return out;
  }

  // ---- calendars ----
  // Last result of talking to Google ('google'), iCloud ('apple') or a calendar link ('feed')
  async calState(which) {
    const all = await read('cal-status', {});
    return all[which] || null;
  }

  async noteCal(which, ok, message) {
    await mutate('cal-status', {}, (all) => {
      all[which] = { ok, message: String(message || '').slice(0, 300), at: Date.now() };
      return all;
    }).catch(() => {}); // a status note is never worth failing the request for
  }

  googleState() { return this.calState('google'); }
  noteGoogle(ok, message) { return this.noteCal('google', ok, message); }

  // Busy times on every connected calendar, Google and Apple: [start, end, calendar name, 'google' | 'apple']
  async calendarBusy(settings, from, to, fresh = false) {
    const [g, a, f] = await Promise.all([this.googleBusy(settings, from, to, fresh), this.appleBusy(settings, from, to, fresh), this.feedBusy(settings, from, to, fresh)]);
    return g.map((r) => [...r, 'google']).concat(a.map((r) => [...r, 'apple']), f.map((r) => [...r, 'feed']));
  }

  // A calendar link's file, fetched at most once a minute (or fresh for the admin)
  async feedText(url, fresh) {
    const hit = feedCache.get(url);
    if (!fresh && hit && Date.now() - hit.at < 60e3) return hit.text;
    try {
      const text = await fetchFeed(url);
      feedCache.set(url, { at: Date.now(), text });
      if (feedCache.size > 20) feedCache.delete(feedCache.keys().next().value);
      return text;
    } catch (err) {
      if (hit) return hit.text; // keep what we had if the link is briefly unreachable
      throw err;
    }
  }

  // Times taken up on the calendar links, like googleBusy
  async feedBusy(settings, from, to, fresh = false) {
    if (!settings.feeds.length) return [];
    const fromMs = (dayNum(from) - 1) * 864e5;
    const toMs = (dayNum(to) + 2) * 864e5;
    const failed = [];
    const results = await Promise.all(settings.feeds.map(async (f) => {
      try {
        const name = f.label || 'Calendar link';
        return icsEvents(await this.feedText(f.url, fresh), fromMs, toMs, null).filter((e) => f.block[e.kind]).map((e) => [e.start, e.end, name]);
      } catch (err) {
        failed.push(`${f.label || 'Calendar link'} (${err.message})`);
        return [];
      }
    }));
    if (failed.length) await this.noteCal('feed', false, `Can't read: ${failed.join(', ')}`.slice(0, 300));
    else if (fresh) await this.noteCal('feed', true, 'Last check worked.');
    return [].concat(...results);
  }

  // For the admin's "Test link" button
  async testFeed(url) {
    url = feedUrl(url);
    if (!url) return { ok: false, message: 'Paste the calendar link first (it starts with https:// or webcal://).' };
    try {
      const text = await fetchFeed(url);
      feedCache.set(url, { at: Date.now(), text });
      const today = dayNum(nowLA().date);
      const n = icsEvents(text, today * 864e5, (today + 60) * 864e5, null).length;
      return { ok: true, message: `Connected. Found ${n} events in the next 60 days.` };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  // Times taken up on the connected calendars between two dates, as wall-clock minute ranges
  // [start, end, calendar name]. Cached for a minute.
  async googleBusy(settings, from, to, fresh = false) {
    const cals = settings.google.calendars.filter((c) => c.busy);
    if (!cals.length || !serviceAccount(this.env)) return [];
    const key = `${cals.map((c) => `${c.id}:${+c.block.busy}${+c.block.free}${+c.block.allDay}`).join(',')}|${from}|${to}`;
    const hit = busyCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < 60e3) return hit.ranges;
    // a day either side covers the time-zone offset; ranges are filtered by date in slots()
    const timeMin = new Date((dayNum(from) - 1) * 864e5).toISOString();
    const timeMax = new Date((dayNum(to) + 2) * 864e5).toISOString();
    const failed = [];
    const results = await Promise.all(cals.map((c) => this.calendarRanges(c, timeMin, timeMax).catch((err) => {
      failed.push(`${c.label || c.id} (${err.status === 404 ? 'notFound' : err.message})`);
      return null;
    })));
    if (failed.length) await this.noteGoogle(false, `Google can't read busy times for: ${failed.join(', ')}. Check each calendar is shared with the service account.`);
    if (results.every((r) => r === null) && hit) return hit.ranges; // if Google is unreachable, keep what we had
    const ranges = [].concat(...results.filter(Boolean));
    busyCache.set(key, { at: Date.now(), ranges });
    if (busyCache.size > 50) busyCache.delete(busyCache.keys().next().value);
    return ranges;
  }

  // One calendar's events as minute ranges, keeping only the kinds chosen in c.block. Falls back to Google's
  // free/busy lookup (Busy events only) when the calendar is shared as "See only free/busy".
  async calendarRanges(c, timeMin, timeMax) {
    const name = c.label || c.id;
    const toRange = (start, end) => {
      if (start.date) return [absMin(start.date, 0), absMin(end.date || start.date, 0) + (end.date ? 0 : 1440), name]; // all-day: whole days
      const a = laParts(Date.parse(start.dateTime));
      const b = laParts(Date.parse(end.dateTime));
      return [absMin(a.date, a.min), absMin(b.date, b.min), name];
    };
    try {
      const out = [];
      let pageToken = '';
      for (let page = 0; page < 5; page++) {
        const q = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', maxResults: '2500', fields: 'nextPageToken,items(status,transparency,start,end,attendees(self,responseStatus))' });
        if (pageToken) q.set('pageToken', pageToken);
        const d = await gcal(this.env, 'GET', `${calPath(c.id)}/events?${q}`);
        for (const ev of d.items || []) {
          if (ev.status === 'cancelled' || !ev.start || !ev.end) continue;
          const me = (ev.attendees || []).find((x) => x.self);
          if (me && me.responseStatus === 'declined') continue;
          const kind = ev.start.date ? 'allDay' : ev.transparency === 'transparent' ? 'free' : 'busy';
          if (!c.block[kind]) continue;
          out.push(toRange(ev.start, ev.end));
        }
        if (!d.nextPageToken) break;
        pageToken = d.nextPageToken;
      }
      return out;
    } catch (err) {
      if (err.status !== 403 && err.status !== 404) throw err;
      const d = await gcal(this.env, 'POST', '/freeBusy', { timeMin, timeMax, timeZone: TZ, items: [{ id: c.id }] });
      const cal = (d.calendars || {})[c.id] || {};
      if (cal.errors && cal.errors.length) { const e = new Error(cal.errors[0].reason); e.status = cal.errors[0].reason === 'notFound' ? 404 : 403; throw e; }
      return c.block.busy ? (cal.busy || []).map((x) => toRange({ dateTime: x.start }, { dateTime: x.end })) : [];
    }
  }

  // The same for the Apple calendars chosen to block booking, read from iCloud
  async appleBusy(settings, from, to, fresh = false) {
    const cals = settings.apple.calendars.filter((c) => c.busy);
    if (!cals.length || !appleAccount(this.env)) return [];
    const key = `apple|${cals.map((c) => `${c.url}:${+c.block.busy}${+c.block.free}${+c.block.allDay}`).join(',')}|${from}|${to}`;
    const hit = busyCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < 60e3) return hit.ranges;
    const fromMs = (dayNum(from) - 1) * 864e5;
    const toMs = (dayNum(to) + 2) * 864e5;
    const failed = [];
    const results = await Promise.all(cals.map((c) => this.appleRanges(c, fromMs, toMs).catch((err) => {
      failed.push(`${c.label || 'Apple calendar'} (${err.message})`);
      return null;
    })));
    if (failed.length) await this.noteCal('apple', false, `iCloud can't read busy times for: ${failed.join(', ')}.`);
    if (results.every((r) => r === null) && hit) return hit.ranges; // if iCloud is unreachable, keep what we had
    const ranges = [].concat(...results.filter(Boolean));
    busyCache.set(key, { at: Date.now(), ranges });
    if (busyCache.size > 50) busyCache.delete(busyCache.keys().next().value);
    return ranges;
  }

  async appleRanges(c, fromMs, toMs) {
    const t = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query ${DAV_NS}><d:prop><c:calendar-data><c:expand start="${t(fromMs)}" end="${t(toMs)}"/></c:calendar-data></d:prop>` +
      `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${t(fromMs)}" end="${t(toMs)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
    const r = await dav(this.env, 'REPORT', c.url, body, { ...XML, depth: '1' });
    const me = appleAccount(this.env).id;
    const name = c.label || 'Apple calendar';
    return [].concat(...xmlBlocks(r.text, 'calendar-data').map((x) => icsEvents(xmlText(x), fromMs, toMs, me)))
      .filter((e) => c.block[e.kind])
      .map((e) => [e.start, e.end, name]);
  }

  // The doctor's iCloud calendars (that hold events), for the admin to choose from
  async appleCalendars() {
    const acct = appleAccount(this.env);
    if (!acct) return { ok: false, message: 'The Apple ID and app-specific password have not been added to Netlify yet (environment variables APPLE_ID and APPLE_APP_PASSWORD).' };
    try {
      const props = '<d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><a:calendar-color/>';
      const find = async (home) => {
        if (!home) {
          const base = this.env.APPLE_CALDAV_URL || APPLE_CALDAV_BASE;
          const p1 = await propfind(this.env, base, 0, '<d:current-user-principal/>');
          const principal = xmlTag(xmlBlocks(p1.text, 'current-user-principal')[0] || '', 'href');
          if (!principal) throw new Error("iCloud didn't say where this account's calendars are.");
          const p2 = await propfind(this.env, new URL(principal, p1.url).href, 0, '<c:calendar-home-set/>');
          const homeHref = xmlTag(xmlBlocks(p2.text, 'calendar-home-set')[0] || '', 'href');
          if (!homeHref) throw new Error("iCloud didn't say where this account's calendars are.");
          home = new URL(homeHref, p2.url).href;
          await data().setJSON('apple-home', { id: acct.id, url: home });
        }
        const r = await propfind(this.env, home, 1, props);
        const responses = xmlBlocks(r.text, 'response');
        const calendars = responses.map((x) => {
          const type = xmlBlocks(x, 'resourcetype')[0] || '';
          const comps = xmlBlocks(x, 'supported-calendar-component-set')[0];
          if (!/<(?:[\w-]+:)?calendar(?=[\s/>])/i.test(type)) return null;
          if (comps && /comp\b/i.test(comps) && !/name\s*=\s*["']VEVENT["']/i.test(comps)) return null; // reminders lists
          return { url: new URL(xmlTag(x, 'href'), r.url).href, name: xmlTag(x, 'displayname') || 'Calendar', color: (xmlTag(x, 'calendar-color').match(/^#[0-9a-f]{6}/i) || [''])[0] };
        }).filter(Boolean);
        // What iCloud listed (folder names and kinds only), to explain an empty list
        const listed = responses.map((x) => {
          const name = decodeURIComponent(xmlTag(x, 'href').replace(/\/$/, '').split('/').pop() || '');
          const kinds = [...(xmlBlocks(x, 'resourcetype')[0] || '').matchAll(/<(?:[\w-]+:)?([\w-]+)/g)].map((m) => m[1]).join('+');
          return `${name || '/'} (${kinds || 'no type'})`;
        });
        return { calendars, listed };
      };
      const saved = await read('apple-home', null);
      let found = saved && saved.id === acct.id ? await find(saved.url).catch((err) => { if (err.status === 401) throw err; return null; }) : null;
      if (!found || !found.calendars.length) found = await find(''); // look the calendars up again from the start
      const { calendars } = found;
      if (!calendars.length) {
        const message = `Connected, but iCloud listed no calendars with events. It listed: ${found.listed.join(', ').slice(0, 200) || 'nothing'}.`;
        await this.noteCal('apple', false, message);
        return { ok: true, calendars, message };
      }
      await this.noteCal('apple', true, 'Connected to iCloud.');
      return { ok: true, calendars };
    } catch (err) {
      await this.noteCal('apple', false, err.message);
      return { ok: false, message: err.message };
    }
  }

  // Changes one booking in place, leaving every other booking alone.
  async patchBooking(id, patch) {
    return mutate('bookings', [], (all, out) => {
      const i = all.findIndex((b) => b.id === id);
      if (i < 0) { out.value = null; return undefined; } // no such booking: nothing to write
      all[i] = { ...all[i], ...patch };
      out.value = all[i];
      return all;
    });
  }

  // Adds, or (when status isn't confirmed) removes, a booking's calendar events. Never throws.
  async syncEvent(id, origin) {
    const all = await this.allBookings();
    const b = all.find((x) => x.id === id);
    if (!b) return;
    const s = await this.getSettings();
    await this.syncGoogle(b, s.google, origin);
    await this.syncApple(b, s.apple, origin);
  }

  async syncApple(b, a, origin) {
    if (!appleAccount(this.env) || (!a.bookingCalendar && !b.apple_href)) return;
    try {
      const wanted = b.status !== 'cancelled' && a.bookingCalendar;
      if (b.apple_href && (!wanted || b.apple_cal !== a.bookingCalendar)) {
        await dav(this.env, 'DELETE', b.apple_href);
        await this.patchBooking(b.id, { apple_href: '', apple_cal: '' });
        b.apple_href = '';
      }
      if (wanted && !b.apple_href) {
        const href = new URL(`eternawell-${b.id}.ics`, a.bookingCalendar.replace(/\/?$/, '/')).href;
        await dav(this.env, 'PUT', href, icsFor(b, origin), { 'content-type': 'text/calendar; charset=utf-8' });
        await this.patchBooking(b.id, { apple_href: href, apple_cal: a.bookingCalendar });
      }
      busyCache.clear();
      await this.noteCal('apple', true, 'Last calendar update worked.');
    } catch (err) {
      await this.noteCal('apple', false, err.status === 403 || err.status === 404
        ? `iCloud refused the update (${err.message}). Check the calendar still exists and isn't read-only.`
        : err.message);
    }
  }

  async syncGoogle(b, g, origin) {
    const id = b.id;
    if (!serviceAccount(this.env)) return;
    try {
      const wanted = b.status !== 'cancelled' && g.bookingCalendar;
      if (b.gcal_id && (!wanted || b.gcal_cal !== g.bookingCalendar)) {
        await gcal(this.env, 'DELETE', `${calPath(b.gcal_cal)}/events/${encodeURIComponent(b.gcal_id)}`);
        await this.patchBooking(id, { gcal_id: '', gcal_cal: '' });
        b.gcal_id = '';
      }
      if (wanted && !b.gcal_id) {
        const ev = await gcal(this.env, 'POST', `${calPath(g.bookingCalendar)}/events`, eventFor(b, g.detail, origin));
        await this.patchBooking(id, { gcal_id: ev.id || '', gcal_cal: g.bookingCalendar });
      }
      busyCache.clear(); // the calendar changed
      await this.noteGoogle(true, 'Last calendar update worked.');
    } catch (err) {
      await this.noteGoogle(false, err.status === 404 || err.status === 403
        ? `Google Calendar refused the update (${err.message}). Check the calendar ID, and that the calendar is shared with the service account with "Make changes to events".`
        : err.message);
    }
  }

  // Puts every upcoming confirmed booking on the current calendar (after connecting or changing calendars).
  async syncUpcoming(origin) {
    const today = nowLA().date;
    const all = await this.allBookings();
    const ids = all.filter((b) => b.date >= today && b.status === 'confirmed').map((b) => b.id);
    for (const id of ids) await this.syncEvent(id, origin);
    return { count: ids.length, status: await this.googleState(), apple: await this.calState('apple') };
  }

  // Checks the key and the calendar sharing, for the admin's "Test connection" button.
  async testGoogle(calendarId) {
    const sa = serviceAccount(this.env);
    if (!sa) return { ok: false, message: 'The service account key has not been added to Netlify yet.' };
    if (!calendarId) return { ok: false, message: 'Enter the calendar ID first.' };
    try {
      const cal = await gcal(this.env, 'GET', calPath(calendarId));
      const roles = await gcal(this.env, 'GET', `/users/me/calendarList/${encodeURIComponent(calendarId)}`).catch(() => null);
      if (roles && roles.accessRole && !['writer', 'owner'].includes(roles.accessRole)) {
        return { ok: false, message: `Connected to "${cal.summary}", but it's shared as "${roles.accessRole}". Change the sharing permission to "Make changes to events".` };
      }
      return { ok: true, message: `Connected to "${cal.summary}". Bookings can now be added to this calendar.` };
    } catch (err) {
      if (err.status === 404) return { ok: false, message: `Google can't find that calendar. Check the calendar ID, and that the calendar is shared with ${sa.client_email}. A calendar you only subscribe to (under "Other calendars", like EZCall) can't be shared: add its iCal link under Calendar links instead.` };
      return { ok: false, message: err.message };
    }
  }

  async publicInfo() {
    const s = await this.getSettings();
    return { visitTypes: s.visitTypes.filter((t) => t.active).map(({ id, name, name_zh, minutes }) => ({ id, name, name_zh, minutes })), maxDaysAhead: s.maxDaysAhead, today: nowLA().date, clinic: s.clinic };
  }

  async availableDates(typeId, month) {
    const s = await this.getSettings();
    const type = s.visitTypes.find((t) => t.id === typeId && t.active);
    if (!type || !/^\d{4}-\d{2}$/.test(month)) return [];
    const first = dayNum(`${month}-01`);
    const [y, m] = month.split('-').map(Number);
    const last = Date.UTC(y, m, 0) / 864e5;
    const calBusy = await this.calendarBusy(s, dateOf(first), dateOf(last));
    const taken = await this.takenOn(dateOf(first), dateOf(last));
    const out = [];
    for (let d = first; d <= last; d++) if (this.slots(s, type, dateOf(d), taken, calBusy).length) out.push(dateOf(d));
    return out;
  }

  async availableTimes(typeId, date) {
    const s = await this.getSettings();
    const type = s.visitTypes.find((t) => t.id === typeId && t.active);
    if (!type || !isDate(date)) return [];
    const calBusy = await this.calendarBusy(s, date, date);
    return this.slots(s, type, date, await this.takenOn(date, date), calBusy);
  }

  // Creates a booking. Online bookings must fit an open slot; the admin can add any time.
  async createBooking(b, { admin = false, origin = '' } = {}) {
    const s = await this.getSettings();
    const type = s.visitTypes.find((t) => t.id === b.type && (admin || t.active));
    if (!type) return { error: 'Please choose a visit type.' };
    if (!isDate(b.date) || !Number.isInteger(b.start) || b.start < 0 || b.start >= 1440) return { error: 'Please choose a date and time.' };
    if (!MODES.includes(b.mode)) return { error: 'Please choose in person or telemedicine.' };
    const name = String(b.name || '').trim().slice(0, 100);
    const phone = String(b.phone || '').trim().slice(0, 30);
    const email = String(b.email || '').trim().slice(0, 120);
    if (!name) return { error: 'Please enter your name.' };
    if ((phone.match(/\d/g) || []).length < 7) return { error: 'Please enter a phone number we can reach you at.' };
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Please check your email address.' };
    if (!admin && !email) return { error: 'Please enter your email address.' };
    // Read the calendars before the write loop; the slot check below re-reads the bookings every attempt.
    const calBusy = admin ? [] : await this.calendarBusy(s, b.date, b.date, true);
    // Built once, outside the loop, so a retry re-adds the same booking rather than a second one.
    const row = {
      id: randomHex(8), token: randomHex(16), date: b.date, start: b.start, minutes: type.minutes, type: type.id, type_name: type.name,
      mode: b.mode, name, phone, email, status: 'confirmed', note: String(b.note || '').slice(0, 1000), source: admin ? 'admin' : 'online', created: Date.now(),
      gcal_id: '', gcal_cal: '', apple_href: '', apple_cal: '',
    };

    const result = await mutate('bookings', [], (all, out) => {
      const others = all.filter((x) => x.id !== row.id);
      if (!admin) {
        const taken = others.filter((x) => x.date === b.date && ['confirmed', 'completed'].includes(x.status))
          .map((x) => ({ date: x.date, start: x.start, minutes: x.minutes }));
        // Re-checked on every attempt, so if another booking took this time while we were writing, the
        // retry sees it and gives up rather than double-booking the slot.
        if (!this.slots(s, type, b.date, taken, calBusy).includes(b.start)) {
          out.value = { error: 'Sorry, that time was just taken. Please choose another.' };
          return undefined; // somebody else has the slot: refuse without writing
        }
      }
      out.value = { booking: row };
      return [...others, row];
    });
    if (result.error) return result;
    await this.syncEvent(result.booking.id, origin);
    return result;
  }

  async listBookings(view) {
    const s = await this.getSettings();
    const today = nowLA().date;
    const cutoff = dateOf(dayNum(today) - s.retentionDays);
    const rows = await this.allBookings();
    // Only rewrite the document when retention actually has something to delete.
    const all = rows.some((b) => b.date < cutoff)
      ? await mutate('bookings', [], (current, out) => { const kept = current.filter((b) => b.date >= cutoff); out.value = kept; return kept; })
      : rows;
    const by = (a, b, dir) => dir * ((a.date + String(a.start).padStart(4, '0')).localeCompare(b.date + String(b.start).padStart(4, '0')));
    const asc = (a, b) => by(a, b, 1);
    const desc = (a, b) => by(a, b, -1);
    if (view === 'upcoming') return all.filter((b) => b.date >= today && b.status === 'confirmed').sort(asc);
    if (view === 'past') return all.filter((b) => (b.date < today && b.status !== 'cancelled') || b.status === 'completed').sort(desc);
    if (view === 'cancelled') return all.filter((b) => b.status === 'cancelled').sort(desc);
    if (view === 'all') return all.slice().sort(desc);
    return [];
  }

  async updateBooking(id, patch, origin = '') {
    const all = await this.allBookings();
    const row = all.find((b) => b.id === id);
    if (!row) return null;
    const status = ['confirmed', 'completed', 'cancelled'].includes(patch.status) ? patch.status : row.status;
    const note = typeof patch.note === 'string' ? patch.note.slice(0, 1000) : row.note;
    const updated = await this.patchBooking(id, { status, note });
    if (!updated) return null;
    if (status !== row.status) await this.syncEvent(id, origin);
    return updated;
  }

  async deleteBooking(id) {
    await this.patchBooking(id, { status: 'cancelled' });
    await this.syncEvent(id); // removes the calendar event first
    await mutate('bookings', [], (all) => all.filter((b) => b.id !== id));
    return true;
  }

  // Everything for the admin's week calendar: bookings, blocked days and hours, weekly hours, calendar busy times
  async schedule(from, to) {
    if (!isDate(from) || !isDate(to) || dayNum(to) < dayNum(from) || dayNum(to) - dayNum(from) > 62) return null;
    const s = await this.getSettings();
    const all = await this.allBookings();
    const bookings = all
      .filter((b) => b.date >= from && b.date <= to && ['confirmed', 'completed'].includes(b.status))
      .sort((a, b) => (a.date + String(a.start).padStart(4, '0')).localeCompare(b.date + String(b.start).padStart(4, '0')))
      .map(({ id, date, start, minutes, type, type_name, mode, name, phone, email, status, source }) =>
        ({ id, date, start, minutes, type, type_name, mode, name, phone, email, status, source }));
    const google = [];
    for (const [a, b, label, src] of await this.calendarBusy(s, from, to, true)) { // always fresh in the admin
      // split ranges that cross midnight into one piece per day
      for (let d = Math.floor(a / 1440); d * 1440 < b; d++) {
        const date = dateOf(d);
        if (date < from || date > to) continue;
        google.push({ date, start: Math.max(a, d * 1440) - d * 1440, end: Math.min(b, (d + 1) * 1440) - d * 1440, label, src });
      }
    }
    return { bookings, blockedDates: s.blockedDates, blockedTimes: s.blockedTimes, hours: s.hours, google, today: nowLA().date };
  }

  // Adds or removes blocked time. Items are { date, allDay: true } or { date, start: 'HH:MM', end: 'HH:MM' }.
  async updateBlocks(add, remove) {
    const s = await this.getSettings();
    const same = (x, y) => x.date === y.date && x.start === y.start && x.end === y.end;
    for (const r of remove || []) {
      if (!r || !isDate(r.date)) continue;
      if (r.allDay) s.blockedDates = s.blockedDates.filter((d) => d !== r.date);
      else s.blockedTimes = s.blockedTimes.filter((b) => !same(b, r));
    }
    for (const a of add || []) {
      if (!a || !isDate(a.date)) continue;
      if (a.allDay) s.blockedDates.push(a.date);
      else s.blockedTimes.push({ date: a.date, start: a.start, end: a.end });
    }
    const saved = await this.saveSettings(s); // validates, removes duplicates and sorts
    return { blockedDates: saved.blockedDates, blockedTimes: saved.blockedTimes };
  }

  // Messages from the website's "Send the doctor a message" form
  async addMessage(m) {
    const name = String(m.name || '').trim().slice(0, 100);
    const contact = String(m.contact || '').trim().slice(0, 120);
    const message = String(m.message || '').trim().slice(0, 2000);
    if (!name) return { error: 'Please enter your name.' };
    if (!/@/.test(contact) && (contact.match(/\d/g) || []).length < 7) return { error: 'Please enter an email address or phone number so we can reply.' };
    if (!message) return { error: 'Please write a message.' };
    // Built outside mutate() so a retry re-adds the same message, not a second copy of it.
    const row = { id: randomHex(8), name, contact, message, lang: String(m.lang || 'en').slice(0, 10), page: String(m.page || '').slice(0, 200), status: 'new', created: Date.now() };
    await mutate('messages', [], (all) => [...all.filter((x) => x.id !== row.id), row]);
    return { ok: true };
  }

  async listMessages(view) {
    const s = await this.getSettings();
    const keepFrom = Date.now() - s.retentionDays * 864e5;
    const rows = await read('messages', []);
    const all = rows.some((m) => m.created < keepFrom)
      ? await mutate('messages', [], (current, out) => { const kept = current.filter((m) => m.created >= keepFrom); out.value = kept; return kept; })
      : rows;
    const pick = view === 'new' ? all.filter((m) => m.status === 'new') : view === 'read' ? all.filter((m) => m.status === 'read') : all;
    return {
      messages: pick.slice().sort((a, b) => b.created - a.created).slice(0, 500),
      unread: all.filter((m) => m.status === 'new').length,
    };
  }

  async updateMessage(id, status) {
    if (!['new', 'read'].includes(status)) return false;
    await mutate('messages', [], (all) => all.map((m) => (m.id === id ? { ...m, status } : m)));
    return true;
  }

  async deleteMessage(id) {
    await mutate('messages', [], (all) => all.filter((m) => m.id !== id));
    return true;
  }

  async byToken(token) {
    const all = await this.allBookings();
    const r = all.find((b) => b.token === String(token));
    if (!r) return null;
    const t = (await this.getSettings()).visitTypes.find((v) => v.id === r.type);
    const { date, start, minutes, type, type_name, mode, name, status } = r;
    return { date, start, minutes, type, type_name, mode, name, status, type_name_zh: (t && t.name_zh) || '' };
  }

  async cancelByToken(token) {
    const all = await this.allBookings();
    const r = all.find((b) => b.token === String(token) && b.status === 'confirmed');
    if (!r) return false;
    await this.patchBooking(r.id, { status: 'cancelled' });
    await this.syncEvent(r.id);
    return true;
  }
}
