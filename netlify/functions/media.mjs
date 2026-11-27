// Photos the doctor uploaded in the admin. They are stored in Netlify Blobs, not in the repo, so they
// survive deploys and never need to be committed.

import { Store } from '../lib/store.mjs';

export const config = { path: '/media/:id' };

export default async function handler(request, context) {
  const id = String((context.params && context.params.id) || '');
  if (!/^[a-f0-9]{24}$/.test(id)) return new Response('Not found', { status: 404 });
  const m = await new Store(process.env).getMedia(id);
  if (!m) return new Response('Not found', { status: 404 });
  return new Response(m.data, {
    headers: {
      'content-type': m.type,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    },
  });
}
