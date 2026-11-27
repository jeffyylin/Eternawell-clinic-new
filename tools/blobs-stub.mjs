// An in-memory stand-in for @netlify/blobs, so tools/test-api.mjs can run the real functions without a
// Netlify deploy.
//
// This deliberately matches @netlify/blobs v8 exactly, including what it CANNOT do: set() and setJSON()
// take only { metadata }, return nothing, and have no conditional-write option. There is no compare-and-swap
// in Netlify Blobs, which is the whole reason store.mjs writes and then reads back to check its change
// survived. A stub that offered etag guards would make the tests pass and the deployed site wrong.

const stores = new Map();
let seq = 0;

// Every operation waits a little, so concurrent requests really do interleave the way they would against a
// network. Without this, each await resolves in the same microtask and races never actually happen.
// BLOBS_LATENCY_MS sets the upper bound (default 6ms).
const MAX_LATENCY = Number(process.env.BLOBS_LATENCY_MS ?? 6);
const latency = () => (MAX_LATENCY > 0 ? new Promise((r) => setTimeout(r, Math.random() * MAX_LATENCY)) : Promise.resolve());

export function getStore(options) {
  const name = typeof options === 'string' ? options : options.name;
  if (!stores.has(name)) stores.set(name, new Map());
  const entries = stores.get(name);

  const body = (entry, type) => {
    if (type === 'json') return JSON.parse(entry.value);
    if (type === 'arrayBuffer') return entry.bytes;
    return entry.value;
  };

  return {
    async get(key, opts = {}) {
      await latency();
      const e = entries.get(key);
      return e ? body(e, opts.type) : null;
    },
    async getWithMetadata(key, opts = {}) {
      await latency();
      const e = entries.get(key);
      return e ? { data: body(e, opts.type), etag: e.etag, metadata: e.metadata } : null;
    },
    // Note the signature: only metadata, and no return value. Exactly like the real thing.
    async set(key, value, opts = {}) {
      await latency();
      seq += 1;
      const isBytes = value instanceof ArrayBuffer || value instanceof Uint8Array;
      entries.set(key, {
        etag: `"${seq}"`,
        metadata: opts.metadata,
        value: isBytes ? '' : String(value),
        bytes: isBytes ? (value instanceof ArrayBuffer ? value : value.buffer) : null,
      });
    },
    async setJSON(key, value, opts = {}) {
      await this.set(key, JSON.stringify(value), opts);
    },
    async delete(key) {
      entries.delete(key);
    },
    async list({ prefix = '' } = {}) {
      return { blobs: [...entries.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, etag: entries.get(key).etag })), directories: [] };
    },
  };
}

// Lets a test start from nothing
export function __reset() {
  stores.clear();
}
