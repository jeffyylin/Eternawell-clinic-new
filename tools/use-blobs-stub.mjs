// Points imports of @netlify/blobs at tools/blobs-stub.mjs. Used by the API test:
//   node --import ./tools/use-blobs-stub.mjs tools/test-api.mjs

import { register } from 'node:module';

register(new URL('./blobs-resolver.mjs', import.meta.url));
