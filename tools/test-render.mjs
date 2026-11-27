// Checks the edge function's HTML rendering against the real pages in site/v8.
//
//   node tools/test-render.mjs
//
// HTMLRewriter parsed the page properly; the Netlify version works on the HTML text, so these tests exist to
// prove it does not corrupt the markup. The strongest one is "passthrough": with nothing saved in the admin,
// the rendered page must be byte-identical to the file on disk apart from the phone and map links.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '../netlify/edge-functions/pages.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLINIC = { phone: '(206) 555-0101', address1: '1 Test St, Suite 2', address2: 'Bellevue, WA 98005' };
const TEL = '+12065550101';
// Deliberately not a google.com/maps address, so "no map link was left unrewritten" is a real check
const MAP = 'https://maps.test/REWRITTEN';

let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => { if (ok) pass += 1; else fails.push(`${name}${detail ? `: ${detail}` : ''}`); };

function pages(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) pages(p, out);
    else if (e.endsWith('.html')) out.push(p);
  }
  return out;
}

const keysIn = (html, attr) => [...html.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g'))].map((m) => m[1]);
const count = (s, needle) => s.split(needle).length - 1;

const files = pages(join(ROOT, 'site', 'v8'));
check('found the v8 pages', files.length > 0, `${files.length} files`);

for (const file of files) {
  const name = file.slice(ROOT.length).replace(/\\/g, '/');
  const html = readFileSync(file, 'utf8');

  // 1. Passthrough: nothing saved in the admin, so only the phone and map links may change.
  const plain = render(html, { content: {}, clinic: {}, tel: '', mapUrl: '', editing: false });
  const changed = [];
  const a = html.split('\n');
  const b = plain.split('\n');
  check(`${name} keeps the same number of lines`, a.length === b.length, `${a.length} -> ${b.length}`);
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i] && !/tel:|sms:|google\.com\/maps/.test(a[i])) changed.push(`line ${i + 1}: ${a[i].trim().slice(0, 90)}`);
  }
  check(`${name} changes nothing it should not`, changed.length === 0, changed.slice(0, 3).join(' | '));

  // 2. With content saved: every edited value must appear, and the structure must survive.
  const textKeys = keysIn(html, 'data-edit');
  const imgKeys = keysIn(html, 'data-edit-img');
  const content = {};
  textKeys.forEach((k, i) => { content[k] = `EDITED-${i}-${k.replace(/[^a-z0-9]/gi, '')}`; });
  imgKeys.forEach((k, i) => { content[k] = JSON.stringify({ src: `/media/${'a'.repeat(24)}`, alt: `PHOTO-${i}` }); });
  const full = render(html, { content, clinic: CLINIC, tel: TEL, mapUrl: MAP, editing: false });

  // Structural tags are never inside an edited element, so none may be lost.
  for (const tag of ['div', 'section', 'main', 'header', 'footer', 'nav', 'figure', 'ul', 'li']) {
    check(`${name} keeps every <${tag}>`, count(html, `<${tag}`) === count(full, `<${tag}`), `${count(html, `<${tag}`)} -> ${count(full, `<${tag}`)}`);
    check(`${name} keeps every </${tag}>`, count(html, `</${tag}>`) === count(full, `</${tag}>`), `${count(html, `</${tag}>`)} -> ${count(full, `</${tag}>`)}`);
  }

  // Every saved text edit is on the page, unless a data-set on the same element overrides it (the phone spans).
  const overridden = new Set([...html.matchAll(/<[^>]*data-set="[^"]*"[^>]*data-edit="([^"]+)"[^>]*>/g)].map((m) => m[1]));
  for (const [i, k] of textKeys.entries()) {
    if (overridden.has(k)) continue;
    check(`${name} shows the edit for ${k}`, full.includes(content[k]), `EDITED-${i} missing`);
  }

  // Photos: <img> gets the new src, other elements get an <img> inserted as their first child.
  for (const k of imgKeys) {
    const src = JSON.parse(content[k]).src;
    check(`${name} shows the photo for ${k}`, full.includes(src), 'src missing');
  }
  // An <img> that got a new photo must lose data-stock, so none may be left on one.
  check(`${name} drops data-stock from replaced photos`, !/<img[^>]*data-stock[^>]*data-edit-img|<img[^>]*data-edit-img[^>]*data-stock/.test(full));

  // Clinic details
  if (/data-set="phone"/.test(html)) check(`${name} fills in the phone number`, full.includes(CLINIC.phone));
  if (/data-set="address1"/.test(html)) check(`${name} fills in the address`, full.includes(CLINIC.address1));
  if (/href="tel:/.test(html)) check(`${name} rewrites tel: links`, full.includes(`href="tel:${TEL}"`) && !/href="tel:(?!\+12065550101)/.test(full));
  if (/href="sms:/.test(html)) check(`${name} rewrites sms: links`, full.includes(`href="sms:${TEL}"`) && !/href="sms:(?!\+12065550101)/.test(full));
  if (/google\.com\/maps/.test(html)) check(`${name} rewrites the map link`, full.includes(`href="${MAP}"`) && !/href="https:\/\/www\.google\.com\/maps/.test(full));

  // Scripts must come through untouched, markup inside their strings included.
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    if (m[1].trim()) check(`${name} leaves inline scripts alone`, full.includes(m[1]), m[1].trim().slice(0, 60));
  }

  // 3. The editor is only loaded with ?edit=1 as the signed-in doctor.
  const edit = render(html, { content, clinic: CLINIC, tel: TEL, mapUrl: MAP, editing: true });
  if (/<\/head>/.test(html)) check(`${name} loads the editor stylesheet`, edit.includes('/admin/editor.css'));
  if (/<\/body>/.test(html)) check(`${name} loads the editor script`, edit.includes('/admin/editor.js'));
  check(`${name} does not load the editor otherwise`, !full.includes('/admin/editor.js'));
}

// 4. Small hand-written cases for the fiddly bits.
const one = (html, opts) => render(html, { content: {}, clinic: {}, tel: '+1555', mapUrl: 'M', editing: false, ...opts });

check('replaces nested contents', one('<p data-edit="k">old <b>bold</b> text</p>', { content: { k: 'NEW' } }) === '<p data-edit="k">NEW</p>');
check('keeps siblings after a replacement', one('<p data-edit="k">old</p><p>kept</p>', { content: { k: 'NEW' } }) === '<p data-edit="k">NEW</p><p>kept</p>');
check('handles nesting of the same tag', one('<div data-edit="k">a<div>b</div>c</div><div>after</div>', { content: { k: 'N' } }) === '<div data-edit="k">N</div><div>after</div>');
check('strips a todo class', one('<p class="todo big" data-edit="k">x</p>', { content: { k: 'N' } }) === '<p class="big" data-edit="k">N</p>');
check('data-set beats data-edit', one('<span data-set="phone" data-edit="k">x</span>', { content: { k: 'N' }, clinic: { phone: '206' } }) === '<span data-set="phone" data-edit="k">206</span>');
check('escapes clinic text', one('<span data-set="phone"></span>', { clinic: { phone: '<b>' } }) === '<span data-set="phone">&lt;b&gt;</span>');
check('leaves an element with no saved content alone', one('<p data-edit="k">keep</p>') === '<p data-edit="k">keep</p>');
check('swaps an img src', one('<img src="old.jpg" alt="a" data-stock data-edit-img="k">', { content: { k: '{"src":"/media/x","alt":"b"}' } }) === '<img src="/media/x" alt="b" data-edit-img="k">');
check('inserts an img into a figure', one('<figure data-edit-img="k"><figcaption>c</figcaption></figure>', { content: { k: '{"src":"/media/x","alt":""}' } })
  === '<figure data-edit-img="k"><img src="/media/x" alt="" loading="lazy"><figcaption>c</figcaption></figure>');
check('ignores a > inside an attribute', one('<p title="a > b" data-edit="k">x</p>', { content: { k: 'N' } }) === '<p title="a > b" data-edit="k">N</p>');
check('leaves tags inside a script alone', one('<script>var s = \'<p data-edit="k">x</p>\';</script>', { content: { k: 'N' } }) === '<script>var s = \'<p data-edit="k">x</p>\';</script>');
check('leaves comments alone', one('<!-- <p data-edit="k">x</p> --><p data-edit="k">y</p>', { content: { k: 'N' } }) === '<!-- <p data-edit="k">x</p> --><p data-edit="k">N</p>');
check('rewrites tel and sms', one('<a href="tel:+1999">a</a><a href="sms:+1999">b</a>') === '<a href="tel:+1555">a</a><a href="sms:+1555">b</a>');
check('rewrites a map link', one('<a href="https://www.google.com/maps/search/?api=1&amp;query=old">m</a>') === '<a href="M">m</a>');
check('does not touch other links', one('<a href="/book/">b</a>') === '<a href="/book/">b</a>');
check('survives an unclosed element', one('<p data-edit="k">x', { content: { k: 'N' } }).includes('x'));

console.log(`${pass} checks passed, ${fails.length} failed`);
for (const f of fails.slice(0, 40)) console.log(`  FAIL ${f}`);
process.exit(fails.length ? 1 : 0);
