// Runs the real Netlify functions against an in-memory Netlify Blobs, so the booking flow and the admin can
// be checked without deploying.
//
//   node --import ./tools/use-blobs-stub.mjs tools/test-api.mjs
//
// Google and Apple are not touched: with no GOOGLE_SERVICE_ACCOUNT_KEY / APPLE_ID set, those code paths
// return straight away, exactly as they do on a site that has not connected a calendar.

import api from '../netlify/functions/api.mjs';
import media from '../netlify/functions/media.mjs';
import { dateOf, dayNum, nowLA } from '../netlify/lib/core.mjs';

const SITE = 'https://eternawell.test';

let pass = 0;
const fails = [];
function check(name, ok, detail = '') {
  if (ok) pass += 1;
  else fails.push(`${name}${detail ? `: ${detail}` : ''}`);
}

// One request to the API. `ip` keeps the rate limits in one test from affecting another.
async function call(path, { method = 'GET', body, cookie, ip = '10.0.0.1', type = 'application/json', lang } = {}) {
  const headers = { 'x-nf-client-connection-ip': ip, origin: SITE };
  if (cookie) headers.cookie = cookie;
  if (lang) headers['x-lang'] = lang;
  if (body !== undefined) headers['content-type'] = type;
  const init = { method, headers };
  if (body !== undefined) init.body = typeof body === 'string' || body instanceof ArrayBuffer ? body : JSON.stringify(body);
  const res = await api(new Request(SITE + path, init));
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, cookie: res.headers.get('set-cookie'), headers: res.headers };
}

// ---------- the password ----------
// No ADMIN_PASSWORD set, so it must be "admin"
delete process.env.ADMIN_PASSWORD;

let r = await call('/api/admin/login', { method: 'POST', body: { password: 'wrong' }, ip: '1.1.1.1' });
check('a wrong password is refused', r.status === 401, `${r.status} ${JSON.stringify(r.data)}`);

r = await call('/api/admin/login', { method: 'POST', body: { password: 'admin' }, ip: '1.1.1.2' });
check('the password "admin" works with nothing configured', r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
check('signing in sets a session cookie', /^ew_admin=\d+\./.test(r.cookie || ''), r.cookie || 'no cookie');
check('the cookie is HttpOnly, Secure and SameSite', /HttpOnly/.test(r.cookie) && /Secure/.test(r.cookie) && /SameSite=Strict/.test(r.cookie));
const session = (r.cookie || '').split(';')[0];

r = await call('/api/admin/me');
check('the admin needs a session', r.status === 401, String(r.status));
r = await call('/api/admin/me', { cookie: session });
check('the session is accepted', r.status === 200, String(r.status));
r = await call('/api/admin/me', { cookie: 'ew_admin=9999999999999.forged' });
check('a forged cookie is refused', r.status === 401, String(r.status));

// ADMIN_PASSWORD overrides the default, and changing it invalidates old sessions
process.env.ADMIN_PASSWORD = 'a-much-longer-password';
r = await call('/api/admin/login', { method: 'POST', body: { password: 'admin' }, ip: '1.1.1.3' });
check('the default stops working once ADMIN_PASSWORD is set', r.status === 401, String(r.status));
r = await call('/api/admin/login', { method: 'POST', body: { password: 'a-much-longer-password' }, ip: '1.1.1.4' });
check('ADMIN_PASSWORD is used when set', r.status === 200, String(r.status));
r = await call('/api/admin/me', { cookie: session });
check('changing the password signs everyone out', r.status === 401, String(r.status));
delete process.env.ADMIN_PASSWORD;

r = await call('/api/admin/login', { method: 'POST', body: { password: 'admin' }, ip: '1.1.1.5' });
const admin = (r.cookie || '').split(';')[0];
check('signed back in', r.status === 200);

// Too many tries from one address
let blocked = false;
for (let i = 0; i < 10; i += 1) {
  const a = await call('/api/admin/login', { method: 'POST', body: { password: 'nope' }, ip: '9.9.9.9' });
  if (a.status === 429) blocked = true;
}
check('repeated wrong passwords are rate limited', blocked);

// A cross-site POST is refused
const cross = await api(new Request(`${SITE}/api/admin/login`, { method: 'POST', headers: { origin: 'https://evil.test', 'content-type': 'application/json' }, body: '{}' }));
check('a cross-site post is refused', cross.status === 403, String(cross.status));

// ---------- settings ----------
r = await call('/api/admin/settings', { cookie: admin });
check('settings load', r.status === 200 && Array.isArray(r.data.visitTypes), JSON.stringify(r.data).slice(0, 80));
const settings = r.data;
check('the default visit types are there', settings.visitTypes.length === 3);

settings.clinic.phone = '(206) 555-0199';
settings.minNoticeHours = 1;
r = await call('/api/admin/settings', { method: 'PUT', body: settings, cookie: admin });
check('settings save', r.status === 200 && r.data.clinic.phone === '(206) 555-0199', JSON.stringify(r.data.clinic));
r = await call('/api/admin/settings', { cookie: admin });
check('saved settings come back', r.data.clinic.phone === '(206) 555-0199' && r.data.minNoticeHours === 1);

// Nonsense is rejected rather than stored
r = await call('/api/admin/settings', { method: 'PUT', body: { ...settings, slotStep: 99999, hours: 'rubbish' }, cookie: admin });
check('settings are validated', r.data.slotStep === 240 && Array.isArray(r.data.hours) && r.data.hours.length === 7, `slotStep ${r.data.slotStep}`);
await call('/api/admin/settings', { method: 'PUT', body: settings, cookie: admin });

// ---------- website text and photos ----------
r = await call('/api/admin/content', {
  method: 'PUT',
  cookie: admin,
  body: { changes: { 'about:abc123': 'Hello <b>there</b><script>alert(1)</script>', 'about:img-abc123': { src: '/media/' + 'a'.repeat(24), alt: 'A photo' }, 'bad key!': 'x' } },
});
check('content saves', r.status === 200 && r.data.saved === 2, JSON.stringify(r.data));

r = await call('/api/site-data');
check('the pages can read the content', r.status === 200 && r.data.content['about:abc123'] === 'Hello <b>there</b>', JSON.stringify(r.data.content));
check('scripts are stripped from edited text', !JSON.stringify(r.data.content).includes('alert'), JSON.stringify(r.data.content));
check('the photo is saved as src and alt', JSON.parse(r.data.content['about:img-abc123']).alt === 'A photo');
check('site-data carries the clinic details', r.data.clinic.phone === '(206) 555-0199');
check('site-data holds no patient data', !JSON.stringify(r.data).includes('bookings') && !('messages' in r.data));

r = await call('/api/admin/content', { cookie: admin });
check('the admin lists the edits', r.status === 200 && r.data.items.length === 2, JSON.stringify(r.data).slice(0, 80));

r = await call('/api/admin/content', { method: 'PUT', cookie: admin, body: { changes: { 'about:abc123': null } } });
r = await call('/api/site-data');
check('an edit can be removed', !('about:abc123' in r.data.content));

// A photo upload, then reading it back from /media/
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
r = await call('/api/admin/media', { method: 'POST', cookie: admin, body: png.buffer, type: 'image/png' });
check('a photo uploads', r.status === 200 && /^\/media\/[a-f0-9]{24}$/.test(r.data.url || ''), JSON.stringify(r.data));
const mediaId = String(r.data.url || '').split('/').pop();
let mres = await media(new Request(`${SITE}/media/${mediaId}`), { params: { id: mediaId } });
check('the photo is served back', mres.status === 200 && mres.headers.get('content-type') === 'image/png', String(mres.status));
check('the photo bytes are unchanged', new Uint8Array(await mres.arrayBuffer()).every((b, i) => b === png[i]));
mres = await media(new Request(`${SITE}/media/deadbeef`), { params: { id: 'deadbeef' } });
check('a bad photo address is a 404', mres.status === 404);
r = await call('/api/admin/media', { method: 'POST', cookie: admin, body: png.buffer, type: 'application/pdf' });
check('only images may be uploaded', r.status === 400, String(r.status));

// ---------- booking ----------
r = await call('/api/booking-info');
check('the booking form loads without signing in', r.status === 200 && r.data.visitTypes.length === 3, String(r.status));
check('booking-info carries the clinic phone', r.data.clinic.phone === '(206) 555-0199');

// A weekday a week or so out, which the default hours have open
let date = null;
for (let d = dayNum(nowLA().date) + 7; d < dayNum(nowLA().date) + 20; d += 1) {
  const wd = new Date(d * 864e5).getUTCDay();
  if (wd >= 1 && wd <= 5) { date = dateOf(d); break; }
}
r = await call(`/api/availability?type=consult&date=${date}`);
check('times are offered', r.status === 200 && r.data.times.length > 0, `${date}: ${JSON.stringify(r.data).slice(0, 80)}`);
const times = r.data.times;
const slot = times[2];

r = await call(`/api/availability?type=consult&month=${date.slice(0, 7)}`);
check('dates are offered for the month', Array.isArray(r.data.dates) && r.data.dates.includes(date), JSON.stringify(r.data).slice(0, 80));

// Consent is required, and the honeypot silently accepts bots
r = await call('/api/bookings', { method: 'POST', ip: '2.2.2.1', body: { type: 'consult', date, start: slot, mode: 'in-person', name: 'A Patient', phone: '2065550123', email: 'a@b.co' } });
check('booking needs the consent box', r.status === 400 && /consent/i.test(r.data.error), JSON.stringify(r.data));
r = await call('/api/bookings', { method: 'POST', ip: '2.2.2.2', body: { website: 'spam', consent: true } });
check('the honeypot field quietly accepts bots', r.status === 200 && r.data.ok === true);

const booking = { type: 'consult', date, start: slot, mode: 'in-person', name: 'A Patient', phone: '2065550123', email: 'a@b.co', consent: true };
r = await call('/api/bookings', { method: 'POST', ip: '2.2.2.3', body: booking });
check('a booking is made', r.status === 200 && r.data.ok === true && r.data.token, JSON.stringify(r.data).slice(0, 120));
const token = r.data.token;

// The same time cannot be taken twice
r = await call('/api/bookings', { method: 'POST', ip: '2.2.2.4', body: booking });
check('the same time cannot be booked twice', r.status === 400 && /just taken/i.test(r.data.error), JSON.stringify(r.data));
r = await call('/api/bookings', { method: 'POST', ip: '2.2.2.5', body: booking, lang: 'zh-Hans' });
check('the Chinese pages get Chinese errors', /抱歉/.test(r.data.error || ''), JSON.stringify(r.data));

r = await call(`/api/availability?type=consult&date=${date}`);
check('the booked time is no longer offered', !r.data.times.includes(slot), JSON.stringify(r.data.times));
check('the other times still are', r.data.times.length === times.length - 1, `${times.length} -> ${r.data.times.length}`);

// Bad details are refused
for (const [label, patch] of [
  ['a missing name', { name: '' }],
  ['a phone number that is too short', { phone: '12' }],
  ['a broken email address', { email: 'not-an-email' }],
  ['a visit type that does not exist', { type: 'nope' }],
  ['a time outside the day', { start: 5000 }],
  ['a visit that is neither in person nor telemedicine', { mode: 'carrier-pigeon' }],
]) {
  const a = await call('/api/bookings', { method: 'POST', ip: '2.2.3.9', body: { ...booking, start: times[5], ...patch } });
  check(`booking refuses ${label}`, a.status === 400, `${a.status} ${JSON.stringify(a.data)}`);
}

// The patient's own link
r = await call(`/api/booking?t=${token}`);
check('a patient can look up their booking', r.status === 200 && r.data.booking.name === 'A Patient', JSON.stringify(r.data).slice(0, 100));
check('the lookup carries no phone or email', !('phone' in r.data.booking) && !('email' in r.data.booking), JSON.stringify(r.data.booking));
r = await call('/api/booking?t=nonsense');
check('an unknown booking link is a 404', r.status === 404);

// Six bookings an hour per connection
let limited = false;
for (let i = 0; i < 8; i += 1) {
  const a = await call('/api/bookings', { method: 'POST', ip: '3.3.3.3', body: { ...booking, start: times[(i % (times.length - 2)) + 3] } });
  if (a.status === 429) limited = true;
}
check('bookings are rate limited per connection', limited);

// ---------- the admin's side of bookings ----------
r = await call('/api/admin/bookings?view=upcoming', { cookie: admin });
check('the admin lists upcoming bookings', r.status === 200 && r.data.bookings.length >= 1, JSON.stringify(r.data).slice(0, 80));
const first = r.data.bookings.find((b) => b.token === token);
check('the admin sees the contact details', first && first.phone === '2065550123' && first.email === 'a@b.co');
check('the bookings come back in time order', r.data.bookings.every((b, i, all) => i === 0 || all[i - 1].date + all[i - 1].start <= b.date + b.start));

r = await call(`/api/admin/bookings/${first.id}`, { method: 'PATCH', cookie: admin, body: { status: 'completed', note: 'Seen.' } });
check('a booking can be marked done', r.status === 200 && r.data.booking.status === 'completed' && r.data.booking.note === 'Seen.', JSON.stringify(r.data).slice(0, 100));
r = await call('/api/admin/bookings?view=past', { cookie: admin });
check('it moves to the past list', r.data.bookings.some((b) => b.id === first.id));

// The admin can book outside the open hours
r = await call('/api/admin/bookings', { method: 'POST', cookie: admin, body: { type: 'consult', date, start: 1380, mode: 'telemedicine', name: 'Late Patient', phone: '2065550124' } });
check('the admin can book any time', r.status === 200 && r.data.booking.start === 1380, JSON.stringify(r.data).slice(0, 100));
check('the admin does not have to give an email', r.data.booking.email === '');
const lateId = r.data.booking.id;

r = await call(`/api/admin/bookings/${lateId}`, { method: 'DELETE', cookie: admin });
check('a booking can be deleted', r.status === 200);
r = await call('/api/admin/bookings?view=all', { cookie: admin });
check('the deleted booking is gone', !r.data.bookings.some((b) => b.id === lateId));

// Cancelling from the patient's link. A fresh booking, because the one above was marked completed and only
// a confirmed booking can be cancelled.
r = await call(`/api/availability?type=consult&date=${date}`);
const freeSlot = r.data.times[0];
r = await call('/api/bookings', { method: 'POST', ip: '5.5.5.1', body: { ...booking, start: freeSlot } });
check('a booking to cancel was made', r.status === 200 && r.data.token, JSON.stringify(r.data).slice(0, 100));
const cancelToken = r.data.token;

r = await call('/api/booking/cancel', { method: 'POST', body: { t: cancelToken } });
check('a patient can cancel', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
r = await call('/api/booking/cancel', { method: 'POST', body: { t: cancelToken } });
check('cancelling twice is refused', r.status === 404, String(r.status));
r = await call(`/api/availability?type=consult&date=${date}`);
check('a cancelled time is offered again', r.data.times.includes(freeSlot), JSON.stringify(r.data.times));
r = await call('/api/admin/bookings?view=cancelled', { cookie: admin });
check('the admin can see cancelled bookings', r.data.bookings.some((b) => b.token === cancelToken));

// ---------- two people booking at once ----------
// The Durable Object handled one request at a time, so "is the slot free?" then "insert" could not be
// interleaved. On Netlify that guarantee comes from the etag check in store.mjs instead, so it is worth
// proving: ten simultaneous attempts at one time must produce exactly one booking.
r = await call(`/api/availability?type=consult&date=${date}`);
const raceSlot = r.data.times[r.data.times.length - 1];
const attempts = await Promise.all(Array.from({ length: 10 }, (_, i) =>
  call('/api/bookings', { method: 'POST', ip: `7.7.7.${i}`, body: { ...booking, start: raceSlot, name: `Racer ${i}` } })));
const won = attempts.filter((a) => a.status === 200);
const lost = attempts.filter((a) => a.status === 400 && /just taken/i.test(a.data.error || ''));
check('exactly one of ten simultaneous bookings wins', won.length === 1, `${won.length} succeeded, ${lost.length} told the time was taken`);
check('the other nine are told the time was taken', lost.length === 9, `${lost.length} of 9`);
r = await call('/api/admin/bookings?view=all', { cookie: admin });
check('only one booking was stored for that time', r.data.bookings.filter((b) => b.date === date && b.start === raceSlot).length === 1);

// Writes to different bookings must not overwrite each other either.
r = await call('/api/admin/bookings?view=all', { cookie: admin });
const before = r.data.bookings.length;
const ids = r.data.bookings.slice(0, 4).map((b) => b.id);
await Promise.all(ids.map((id, i) => call(`/api/admin/bookings/${id}`, { method: 'PATCH', cookie: admin, body: { note: `note ${i}` } })));
r = await call('/api/admin/bookings?view=all', { cookie: admin });
check('simultaneous edits lose no bookings', r.data.bookings.length === before, `${before} -> ${r.data.bookings.length}`);
check('simultaneous edits all stick', ids.every((id, i) => (r.data.bookings.find((b) => b.id === id) || {}).note === `note ${i}`),
  JSON.stringify(r.data.bookings.filter((b) => ids.includes(b.id)).map((b) => b.note)));

// ---------- blocked time and the week view ----------
r = await call('/api/admin/blocks', { method: 'POST', cookie: admin, body: { add: [{ date, allDay: true }, { date, start: '09:00', end: '10:00' }] } });
check('time can be blocked', r.status === 200 && r.data.blockedDates.includes(date) && r.data.blockedTimes.length === 1, JSON.stringify(r.data));
r = await call(`/api/availability?type=consult&date=${date}`);
check('a blocked day offers nothing', r.data.times.length === 0, JSON.stringify(r.data.times));
r = await call('/api/admin/blocks', { method: 'POST', cookie: admin, body: { remove: [{ date, allDay: true }] } });
check('a block can be removed', !r.data.blockedDates.includes(date));

r = await call(`/api/admin/schedule?from=${date}&to=${date}`, { cookie: admin });
check('the week view loads', r.status === 200 && Array.isArray(r.data.bookings) && Array.isArray(r.data.hours), JSON.stringify(r.data).slice(0, 80));
check('the week view has no calendar busy times without a calendar connected', r.data.google.length === 0);
r = await call('/api/admin/schedule?from=2026-01-01&to=2027-01-01', { cookie: admin });
check('the week view refuses a huge range', r.status === 400, String(r.status));

// ---------- messages ----------
r = await call('/api/messages', { method: 'POST', ip: '4.4.4.1', body: { name: 'Asker', contact: 'asker@example.com', message: 'Do you take my insurance?', consent: true } });
check('a message is sent', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
r = await call('/api/messages', { method: 'POST', ip: '4.4.4.2', body: { name: 'Asker', contact: 'nope', message: 'Hi', consent: true } });
check('a message needs a way to reply', r.status === 400 && /email|phone/i.test(r.data.error), JSON.stringify(r.data));
r = await call('/api/messages', { method: 'POST', ip: '4.4.4.3', body: { name: 'Asker', contact: 'a@b.co', message: 'Hi' } });
check('a message needs the consent box', r.status === 400, String(r.status));

r = await call('/api/admin/messages?view=all', { cookie: admin });
check('the admin reads messages', r.status === 200 && r.data.messages.length === 1 && r.data.unread === 1, JSON.stringify(r.data).slice(0, 100));
const msgId = r.data.messages[0].id;
r = await call(`/api/admin/messages/${msgId}`, { method: 'PATCH', cookie: admin, body: { status: 'read' } });
check('a message can be marked read', r.status === 200);
r = await call('/api/admin/messages?view=all', { cookie: admin });
check('the unread count drops', r.data.unread === 0, JSON.stringify(r.data).slice(0, 60));
r = await call(`/api/admin/messages/${msgId}`, { method: 'DELETE', cookie: admin });
check('a message can be deleted', r.status === 200);
r = await call('/api/admin/messages?view=all', { cookie: admin });
check('the deleted message is gone', r.data.messages.length === 0);

// ---------- calendars, with nothing connected ----------
r = await call('/api/admin/google', { cookie: admin });
check('the Google panel loads with no key added', r.status === 200 && r.data.keyAdded === false, JSON.stringify(r.data));
r = await call('/api/admin/apple', { cookie: admin });
check('the Apple panel loads with no Apple ID added', r.status === 200 && r.data.added === false, JSON.stringify(r.data));
r = await call('/api/admin/feeds', { cookie: admin });
check('the calendar links panel loads', r.status === 200);
r = await call('/api/admin/google/test', { method: 'POST', cookie: admin, body: { calendarId: 'x@group.calendar.google.com' } });
check('testing Google says the key is missing', r.status === 200 && r.data.ok === false && /not been added/i.test(r.data.message), JSON.stringify(r.data));
r = await call('/api/admin/feeds/test', { method: 'POST', cookie: admin, body: { url: 'not-a-url' } });
check('testing a bad calendar link explains itself', r.data.ok === false && /calendar link/i.test(r.data.message), JSON.stringify(r.data));

// ---------- everything admin needs the session ----------
for (const path of ['/api/admin/settings', '/api/admin/content', '/api/admin/bookings', '/api/admin/messages', '/api/admin/schedule', '/api/admin/google', '/api/admin/apple', '/api/admin/feeds']) {
  const a = await call(path);
  check(`${path} needs a session`, a.status === 401, String(a.status));
}
r = await call('/api/admin/nonsense', { cookie: admin });
check('an unknown admin address is a 404', r.status === 404, String(r.status));
r = await call('/api/nonsense');
check('an unknown api address is a 404', r.status === 404, String(r.status));

r = await call('/api/admin/logout', { method: 'POST', cookie: admin });
check('signing out clears the cookie', r.status === 200 && /ew_admin=;/.test(r.cookie || ''), r.cookie || 'no cookie');

console.log(`${pass} checks passed, ${fails.length} failed`);
for (const f of fails) console.log(`  FAIL ${f}`);
process.exit(fails.length ? 1 : 0);
