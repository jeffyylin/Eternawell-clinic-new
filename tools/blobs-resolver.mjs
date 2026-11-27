// Module-resolution hook: every import of @netlify/blobs becomes tools/blobs-stub.mjs.

const STUB = new URL('./blobs-stub.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === '@netlify/blobs') return { url: STUB, shortCircuit: true };
  return next(specifier, context);
}
