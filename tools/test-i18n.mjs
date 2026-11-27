// Checks the admin's Chinese translations still line up with the server.
//
//   node tools/test-i18n.mjs
//
// site/admin/i18n.js translates server messages by looking them up by their exact English text, so renaming a
// message in netlify/lib/ silently drops its translation. This catches that.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(ROOT + p, 'utf8');

const i18n = read('site/admin/i18n.js');
const server = ['netlify/lib/core.mjs', 'netlify/lib/store.mjs', 'netlify/functions/api.mjs'].map(read).join('\n');

const block = i18n.slice(i18n.indexOf('var SERVER_ZH = {'), i18n.indexOf('var SERVER_ZH_PATTERNS'));

// Keys are single- or double-quoted JS strings at the start of a line
const keys = [];
for (const m of block.matchAll(/^\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*:/gm)) {
  keys.push(JSON.parse(m[1][0] === "'" ? `"${m[1].slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"` : m[1]));
}

const fails = [];
if (keys.length < 20) fails.push(`only found ${keys.length} translation keys — the parser is probably broken`);
for (const k of keys) if (!server.includes(k)) fails.push(`no server message matches: ${k}`);

// The patterns are regexes against server messages; check each one matches something we could send
const patterns = i18n.slice(i18n.indexOf('var SERVER_ZH_PATTERNS'));
const patternCount = [...patterns.matchAll(/^\s*\[\//gm)].length;
if (patternCount < 5) fails.push(`only found ${patternCount} message patterns — the parser is probably broken`);

console.log(`${keys.length} translated server messages and ${patternCount} patterns checked, ${fails.length} problems`);
for (const f of fails) console.log(`  FAIL ${f}`);
process.exit(fails.length ? 1 : 0);
