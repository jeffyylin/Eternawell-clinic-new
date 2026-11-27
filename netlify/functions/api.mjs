// Every /api/ address for the EternaWell site: online booking, the "Send the doctor a message" form, and
// the admin area. This is the api() handler from the Cloudflare Worker, with Worker secrets replaced by
// Netlify environment variables and the Durable Object replaced by netlify/lib/store.mjs.

import { MAX_MEDIA_BYTES, SESSION_HOURS, appleAccount, bad, json, nowLA, sanitizeHtml, serviceAccount, tr } from '../lib/core.mjs';
import { Store } from '../lib/store.mjs';
import { isAdmin, makeSession, passwordMatches, sessionCookie } from '../lib/auth.mjs';

export const config = { path: '/api/*' };

async function readJson(request, limit = 200_000) {
  const text = await request.text();
  if (text.length > limit) throw new Error('too large');
  return text ? JSON.parse(text) : {};
}

export default async function handler(request) {
  const url = new URL(request.url);
  const lang = request.headers.get('x-lang') || 'en';
  try {
    return await api(request, process.env, url, lang);
  } catch (err) {
    console.error(err);
    return bad(tr(lang, 'Something went wrong. Please try again, or call or text us.'), 500);
  }
}

async function api(request, env, url, lang) {
  const db = new Store(env);
  const path = url.pathname.replace(/\/$/, '') || '/';
  const method = request.method;
  // Netlify's header for the visitor's address (Cloudflare used cf-connecting-ip)
  const ip = request.headers.get('x-nf-client-connection-ip') || request.headers.get('x-forwarded-for') || 'local';
  const fail = (msg, status = 400) => bad(tr(lang, msg), status);

  // Writes must come from this site (blocks cross-site form posts).
  if (method !== 'GET') {
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) return bad('Forbidden', 403);
  }

  // Public: booking
  if (path === '/api/booking-info' && method === 'GET') return json(await db.publicInfo());
  if (path === '/api/availability' && method === 'GET') {
    const type = url.searchParams.get('type') || '';
    if (url.searchParams.get('date')) return json({ times: await db.availableTimes(type, url.searchParams.get('date')) });
    return json({ dates: await db.availableDates(type, url.searchParams.get('month') || '') });
  }
  if (path === '/api/bookings' && method === 'POST') {
    const body = await readJson(request, 10_000);
    if (body.website) return json({ ok: true }); // honeypot field filled in: a bot
    if (body.consent !== true) return fail('Please confirm the consent box to book.');
    if (!(await db.hit(`book:${ip}`, 6, 3600))) return fail('Too many bookings from this connection. Please call or text us.', 429);
    const r = await db.createBooking({ type: body.type, date: body.date, start: Number(body.start), mode: body.mode, name: body.name, phone: body.phone, email: body.email }, { origin: url.origin });
    if (r.error) return fail(r.error);
    const b = r.booking;
    const vt = (await db.getSettings()).visitTypes.find((v) => v.id === b.type);
    return json({ ok: true, booking: { date: b.date, start: b.start, minutes: b.minutes, type_name: b.type_name, type_name_zh: (vt && vt.name_zh) || '', mode: b.mode, name: b.name }, token: b.token });
  }
  if (path === '/api/booking' && method === 'GET') {
    const b = await db.byToken(url.searchParams.get('t') || '');
    return b ? json({ booking: b }) : fail('Booking not found.', 404);
  }
  if (path === '/api/booking/cancel' && method === 'POST') {
    const body = await readJson(request, 2_000);
    return (await db.cancelByToken(body.t || '')) ? json({ ok: true }) : fail('This booking could not be cancelled. Please call or text us.', 404);
  }

  if (path === '/api/messages' && method === 'POST') {
    const body = await readJson(request, 10_000);
    if (body.website) return json({ ok: true }); // honeypot
    if (body.consent !== true) return fail('Please confirm the consent box to send your message.');
    if (!(await db.hit(`msg:${ip}`, 5, 3600))) return fail('Too many messages from this connection. Please call or text us.', 429);
    const r = await db.addMessage({ ...body, lang });
    return r.error ? fail(r.error) : json({ ok: true });
  }

  // The doctor's saved text and photos, for the edge function that renders the /v8/ pages. Everything here is
  // already visible on those pages; no patient or booking data is included.
  if (path === '/api/site-data' && method === 'GET') {
    const [content, settings] = await Promise.all([db.getContent(), db.getSettings()]);
    return json({ content, clinic: settings.clinic });
  }

  // Admin
  if (!path.startsWith('/api/admin/')) return bad('Not found', 404);

  if (path === '/api/admin/login' && method === 'POST') {
    if (!(await db.hit(`login:${ip}`, 8, 900))) return bad('Too many sign-in attempts. Please wait 15 minutes.', 429);
    const body = await readJson(request, 2_000);
    if (!(await passwordMatches(body.password || '', env))) return bad('That password is not correct.', 401);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(await makeSession(env), SESSION_HOURS * 3600) });
  }
  if (path === '/api/admin/logout' && method === 'POST') return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
  if (!(await isAdmin(request, env))) return bad('Please sign in.', 401);

  if (path === '/api/admin/me') return json({ ok: true });
  if (path === '/api/admin/settings') {
    if (method === 'GET') return json(await db.getSettings());
    if (method === 'PUT') return json(await db.saveSettings(await readJson(request)));
  }
  if (path === '/api/admin/content') {
    if (method === 'GET') return json({ items: await db.getContentList() });
    if (method === 'PUT') {
      const body = await readJson(request, 1_000_000);
      const changes = {};
      for (const [k, v] of Object.entries(body.changes || {})) {
        if (!/^[a-z0-9:_-]{3,80}$/i.test(k)) continue;
        if (v === null) changes[k] = null;
        else if (k.includes(':img-')) {
          const src = String(v.src || '');
          if (!/^(\/media\/[a-f0-9]+|https:\/\/[^\s"'<>]+)$/.test(src)) continue;
          changes[k] = JSON.stringify({ src, alt: String(v.alt || '').slice(0, 200) });
        } else changes[k] = sanitizeHtml(v).slice(0, 20_000);
      }
      await db.saveContent(changes);
      return json({ ok: true, saved: Object.keys(changes).length });
    }
  }
  if (path === '/api/admin/media' && method === 'POST') {
    const type = (request.headers.get('content-type') || '').split(';')[0];
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) return bad('Please upload a JPEG, PNG or WebP image.');
    const data = await request.arrayBuffer();
    if (data.byteLength > MAX_MEDIA_BYTES) return bad('That image is too large. Please use one under 1.9 MB.');
    const id = await db.putMedia(type, data);
    return json({ url: `/media/${id}` });
  }
  if (path === '/api/admin/bookings') {
    if (method === 'GET') return json({ bookings: await db.listBookings(url.searchParams.get('view') || 'upcoming'), today: nowLA().date });
    if (method === 'POST') {
      const body = await readJson(request, 10_000);
      const r = await db.createBooking({ ...body, start: Number(body.start) }, { admin: true, origin: url.origin });
      return r.error ? bad(r.error) : json({ ok: true, booking: r.booking });
    }
  }
  if (path === '/api/admin/google' && method === 'GET') {
    const sa = serviceAccount(env);
    return json({ keyAdded: !!sa, serviceEmail: sa ? sa.client_email : '', status: await db.googleState() });
  }
  if (path === '/api/admin/google/test' && method === 'POST') {
    const body = await readJson(request, 2_000);
    return json(await db.testGoogle(String(body.calendarId || '').trim()));
  }
  if ((path === '/api/admin/google/sync' || path === '/api/admin/apple/sync') && method === 'POST') return json(await db.syncUpcoming(url.origin));
  if (path === '/api/admin/apple' && method === 'GET') {
    const acct = appleAccount(env);
    return json({ added: !!acct, appleId: acct ? acct.id : '', status: await db.calState('apple') });
  }
  if (path === '/api/admin/apple/calendars' && method === 'POST') return json(await db.appleCalendars());
  if (path === '/api/admin/feeds' && method === 'GET') return json({ status: await db.calState('feed') });
  if (path === '/api/admin/feeds/test' && method === 'POST') {
    const body = await readJson(request, 3_000);
    return json(await db.testFeed(body.url));
  }
  if (path === '/api/admin/schedule' && method === 'GET') {
    const r = await db.schedule(url.searchParams.get('from') || '', url.searchParams.get('to') || '');
    return r ? json(r) : bad('Choose a date range of up to two months.');
  }
  if (path === '/api/admin/blocks' && method === 'POST') {
    const body = await readJson(request, 100_000);
    const add = Array.isArray(body.add) ? body.add.slice(0, 500) : [];
    const remove = Array.isArray(body.remove) ? body.remove.slice(0, 500) : [];
    return json(await db.updateBlocks(add, remove));
  }
  if (path === '/api/admin/messages' && method === 'GET') return json(await db.listMessages(url.searchParams.get('view') || 'all'));
  const mm = path.match(/^\/api\/admin\/messages\/([a-f0-9]+)$/);
  if (mm) {
    if (method === 'PATCH') { const body = await readJson(request, 2_000); return (await db.updateMessage(mm[1], body.status)) ? json({ ok: true }) : bad('Invalid status'); }
    if (method === 'DELETE') { await db.deleteMessage(mm[1]); return json({ ok: true }); }
  }
  const m = path.match(/^\/api\/admin\/bookings\/([a-f0-9]+)$/);
  if (m) {
    if (method === 'PATCH') { const b = await db.updateBooking(m[1], await readJson(request, 5_000), url.origin); return b ? json({ booking: b }) : bad('Not found', 404); }
    if (method === 'DELETE') { await db.deleteBooking(m[1]); return json({ ok: true }); }
  }
  return bad('Not found', 404);
}
