// Renders the /v8/ pages with the doctor's saved edits applied, and loads the inline editor on ?edit=1.
//
// On Cloudflare this was HTMLRewriter. HTMLRewriter is a Workers-only API, so this edge function asks
// Netlify for the static page (context.next()) and applies the same five rules to the HTML itself:
//
//   [data-edit]       replace the element's contents with the doctor's saved text (and drop a "todo" class)
//   [data-edit-img]   on an <img>, swap src/alt; on anything else, insert an <img> as the first child
//   [data-set]        replace the element's contents with the clinic phone or address
//   a[href^=tel:|sms:]            point at the clinic phone number as saved in the admin
//   a[href^=https://www.google.com/maps]  point at the clinic address as saved in the admin
//
// Two details are deliberately kept identical to the Worker, because the pages rely on them:
//  - an element with both data-edit and data-set (e.g. <span data-set="phone" data-edit="book:...">) ends up
//    showing the phone number: HTMLRewriter ran the handlers in registration order and the last one won.
//  - replacing an element's contents drops whatever was inside it, and the inserted text is not re-scanned.
//
// If anything here fails, config.onError sends the visitor the plain static page instead.

export const config = {
  path: '/v8/*',
  excludedPath: ['/v8/assets/*'],
  onError: 'bypass', // on any error, serve the unmodified static page
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
// Elements whose contents are text, not markup: never look for tags inside them
const RAW = new Set(['script', 'style', 'textarea']);

// ---------- the doctor's content ----------
// Same 10-second cache the Worker kept per isolate. The editor always reads through it so the doctor sees a
// save immediately.
let cache = null; // { at, content, clinic }

async function siteData(origin, fresh) {
  if (!fresh && cache && Date.now() - cache.at < 10_000) return cache;
  const res = await fetch(`${origin}/api/site-data`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`site-data ${res.status}`);
  const d = await res.json();
  cache = { at: Date.now(), content: d.content || {}, clinic: d.clinic || {} };
  return cache;
}

// ---------- is this the doctor, with the editor open? ----------
// The same session cookie the admin API issues: an expiry time plus an HMAC of it keyed on the password.
const COOKIE = 'ew_admin';
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function isAdmin(request) {
  const password = Netlify.env.get('ADMIN_PASSWORD') || 'admin';
  const m = (request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`${password}|eternawell-session`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`admin.${exp}`));
  return b64url(expected) === sig;
}

// ---------- a very small HTML reader ----------
// Reads one tag starting at `lt`, respecting quoted attribute values so a ">" inside one does not end it.
function readTag(html, lt) {
  const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(lt, lt + 80));
  if (!m) return null;
  let j = lt + m[0].length;
  let quote = '';
  while (j < html.length) {
    const c = html[j];
    if (quote) { if (c === quote) quote = ''; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '>') break;
    j++;
  }
  const end = Math.min(j + 1, html.length);
  const text = html.slice(lt, end);
  return { name: m[2].toLowerCase(), closing: m[1] === '/', selfClosing: text.endsWith('/>'), text, end };
}

// Where the element opened at `from` closes, counting nested tags of the same name
function findClose(html, name, from) {
  let depth = 1;
  let i = from;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) return null;
    if (html.startsWith('<!--', lt)) { const e = html.indexOf('-->', lt); i = e < 0 ? html.length : e + 3; continue; }
    const t = readTag(html, lt);
    if (!t) { i = lt + 1; continue; }
    if (RAW.has(t.name) && !t.closing && !t.selfClosing) {
      const e = html.toLowerCase().indexOf(`</${t.name}`, t.end);
      i = e < 0 ? html.length : e;
      continue;
    }
    if (t.name === name) {
      if (t.closing) { depth -= 1; if (depth === 0) return lt; }
      else if (!t.selfClosing && !VOID.has(name)) depth += 1;
    }
    i = t.end;
  }
  return null;
}

// An attribute's value, '' for a valueless attribute like data-stock, or null when it is absent
function getAttr(tag, name) {
  const withValue = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, 'i').exec(tag);
  if (withValue) return withValue[2] ?? withValue[3] ?? withValue[4] ?? '';
  return new RegExp(`\\s${name}(?=[\\s/>])`, 'i').test(tag) ? '' : null;
}

function setAttr(tag, name, value) {
  const quoted = `"${String(value).replace(/"/g, '&quot;')}"`;
  const withValue = new RegExp(`(\\s${name}\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s"'=<>\`]+)`, 'i');
  if (withValue.test(tag)) return tag.replace(withValue, (_, lead) => lead + quoted);
  const bare = new RegExp(`(\\s${name})(?=[\\s/>])`, 'i');
  if (bare.test(tag)) return tag.replace(bare, `$1=${quoted}`);
  const close = tag.endsWith('/>') ? '/>' : '>';
  return `${tag.slice(0, tag.length - close.length).replace(/\s+$/, '')} ${name}=${quoted}${close}`;
}

const removeAttr = (tag, name) =>
  tag.replace(new RegExp(`\\s${name}(\\s*=\\s*("[^"]*"|'[^']*'|[^\\s"'=<>\`]+))?`, 'i'), '');

// ---------- the five rules ----------
// Exported so tools/test-render.mjs can check it against the real pages in site/v8.
export function render(html, { content, clinic, tel, mapUrl, editing }) {
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { out += html.slice(i); break; }
    out += html.slice(i, lt);

    if (html.startsWith('<!--', lt)) {
      const e = html.indexOf('-->', lt);
      const end = e < 0 ? html.length : e + 3;
      out += html.slice(lt, end);
      i = end;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const e = html.indexOf('>', lt);
      const end = e < 0 ? html.length : e + 1;
      out += html.slice(lt, end);
      i = end;
      continue;
    }

    const tag = readTag(html, lt);
    if (!tag) { out += '<'; i = lt + 1; continue; }

    if (tag.closing) {
      // The editor's stylesheet and scripts go in as the last child of <head> and <body>
      if (editing && tag.name === 'head') out += '<link rel="stylesheet" href="/admin/editor.css">';
      if (editing && tag.name === 'body') out += '<script src="/admin/i18n.js"></script><script src="/admin/editor.js" defer></script>';
      out += tag.text;
      i = tag.end;
      continue;
    }

    let text = tag.text;

    // tel:, sms: and map links follow the clinic details in the admin
    if (tag.name === 'a') {
      const href = getAttr(text, 'href');
      if (href != null) {
        if (/^tel:/i.test(href) || /^sms:/i.test(href)) text = setAttr(text, 'href', href.slice(0, 4) + tel);
        else if (href.startsWith('https://www.google.com/maps')) text = setAttr(text, 'href', mapUrl);
      }
    }

    // inner: the element's new contents, or null to keep what the page already has
    let inner = null;

    const editKey = getAttr(text, 'data-edit');
    if (editKey != null && content[editKey] != null) {
      inner = content[editKey];
      const cls = getAttr(text, 'class');
      if (cls && /\btodo\b/.test(cls)) text = setAttr(text, 'class', cls.replace(/\btodo\b/, '').trim()); // a filled-in blank
    }

    let prepend = '';
    const imgKey = getAttr(text, 'data-edit-img');
    if (imgKey != null && content[imgKey] != null) {
      let v = null;
      try { v = JSON.parse(content[imgKey]); } catch { v = null; }
      if (v && v.src) {
        if (tag.name === 'img') {
          text = setAttr(text, 'src', v.src);
          text = setAttr(text, 'alt', v.alt || '');
          text = removeAttr(text, 'data-stock');
        } else {
          prepend = `<img src="${escapeHtml(v.src)}" alt="${escapeHtml(v.alt || '')}" loading="lazy">`;
        }
      }
    }

    // Registered last in the Worker, so on an element with both data-edit and data-set this one wins
    const setKey = getAttr(text, 'data-set');
    if (setKey != null) {
      const v = clinic[setKey];
      if (v) inner = escapeHtml(v);
    }

    out += text + prepend;
    i = tag.end;

    if (RAW.has(tag.name) && !tag.selfClosing) {
      const e = html.toLowerCase().indexOf(`</${tag.name}`, tag.end);
      if (e >= 0) { out += html.slice(tag.end, e); i = e; }
      continue;
    }

    if (inner !== null && !tag.selfClosing && !VOID.has(tag.name)) {
      const close = findClose(html, tag.name, tag.end);
      if (close !== null) { out += inner; i = close; }
    }
  }
  return out;
}

export default async function pages(request, context) {
  const res = await context.next();
  if (!(res.headers.get('content-type') || '').includes('text/html')) return res;

  const url = new URL(request.url);
  const editing = url.searchParams.get('edit') === '1' && (await isAdmin(request));
  const { content, clinic } = await siteData(url.origin, editing);

  const phone = clinic.phone || '';
  const tel = '+1' + phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  const mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${clinic.address1 || ''} ${clinic.address2 || ''}`.trim())}`;

  const html = render(await res.text(), { content, clinic, tel, mapUrl, editing });

  const headers = new Headers(res.headers);
  headers.delete('content-length'); // the body length changed
  headers.delete('etag');           // and so did its fingerprint
  headers.set('cache-control', editing ? 'no-store' : 'public, max-age=0, must-revalidate');
  return new Response(html, { status: res.status, headers });
}
