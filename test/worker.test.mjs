import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import SNAPSHOT from '../src/snapshot.js';
import { PATHS } from '../src/registry.js';

// ---- stubs -----------------------------------------------------------------
function fakeKV() {
  const store = new Map();
  return {
    store,
    async get(key, opts) {
      const e = store.get(key);
      if (!e) return null;
      return opts?.type === 'json' ? JSON.parse(e.value) : e.value;
    },
    async getWithMetadata(key) {
      const e = store.get(key);
      return e ? { value: e.value, metadata: e.metadata } : { value: null, metadata: null };
    },
    async put(key, value, opts) {
      store.set(key, { value, metadata: opts?.metadata });
    },
  };
}

function fakeCache() {
  const store = new Map();
  return {
    async match(req) {
      const e = store.get(req.url);
      return e ? new Response(e.text, { status: e.status, headers: new Headers(e.headers) }) : undefined;
    },
    async put(req, resp) {
      const text = await resp.clone().text();
      store.set(req.url, { text, status: resp.status, headers: [...resp.headers] });
    },
    async delete(req) { return store.delete(req.url); },
  };
}

function ctxFactory() {
  const pending = [];
  return { ctx: { waitUntil: (p) => pending.push(p) }, settle: () => Promise.all(pending) };
}

// Route fetch() by origin URL. `routes` maps URL -> { status, body } | Error.
function installFetch(routes) {
  globalThis.fetch = async (url) => {
    const u = typeof url === 'string' ? url : url.url;
    const r = routes[u];
    if (r === undefined) throw new Error(`unexpected fetch ${u}`);
    if (r instanceof Error) throw r;
    return new Response(r.body, { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
}

const MODELS_URL = 'https://pricing.hanzo.ai/v1/models';
const MODELS_JSON = JSON.stringify({ object: 'list', data: [{ id: 'zen5', object: 'model' }] });
const req = (path, init) => new Request(`https://catalog.hanzo.ai${path}`, init);

test('index / lists the registry resources', async () => {
  globalThis.caches = { default: fakeCache() };
  const res = await worker.fetch(req('/'), { CATALOG: fakeKV() }, ctxFactory().ctx);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.service, 'hanzo-public-catalog');
  assert.deepEqual(body.resources.map((r) => r.path).sort(), [...PATHS].sort());
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('/health returns ok', async () => {
  globalThis.caches = { default: fakeCache() };
  const res = await worker.fetch(req('/health'), {}, ctxFactory().ctx);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('GET /v1/models served from KV (durable) with public cache headers', async () => {
  globalThis.caches = { default: fakeCache() };
  const kv = fakeKV();
  await kv.put('/v1/models', MODELS_JSON, { metadata: { updated: '2026-06-30T00:00:00Z', etag: 'W/"x"' } });
  const { ctx } = ctxFactory();
  const res = await worker.fetch(req('/v1/models'), { CATALOG: kv }, ctx);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-catalog-source'), 'kv');
  assert.match(res.headers.get('cache-control'), /stale-while-revalidate=86400/);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal((await res.json()).data[0].id, 'zen5');
});

test('cold KV: read-through to origin, then persists to KV', async () => {
  globalThis.caches = { default: fakeCache() };
  installFetch({ [MODELS_URL]: { body: MODELS_JSON } });
  const kv = fakeKV();
  const { ctx, settle } = ctxFactory();
  const res = await worker.fetch(req('/v1/models'), { CATALOG: kv }, ctx);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-catalog-source'), 'origin');
  await settle();
  assert.equal(kv.store.get('/v1/models').value, MODELS_JSON); // persisted
});

test('edge cache hit on second request', async () => {
  globalThis.caches = { default: fakeCache() };
  installFetch({ [MODELS_URL]: { body: MODELS_JSON } });
  const env = { CATALOG: fakeKV() };
  const c1 = ctxFactory();
  const r1 = await worker.fetch(req('/v1/models'), env, c1.ctx);
  assert.equal(r1.headers.get('x-catalog-cache'), 'miss');
  await c1.settle();
  const r2 = await worker.fetch(req('/v1/models'), env, ctxFactory().ctx);
  assert.equal(r2.headers.get('x-catalog-cache'), 'hit');
});

test('If-None-Match yields 304', async () => {
  globalThis.caches = { default: fakeCache() };
  const kv = fakeKV();
  await kv.put('/v1/models', MODELS_JSON, { metadata: {} });
  const r1 = await worker.fetch(req('/v1/models'), { CATALOG: kv }, ctxFactory().ctx);
  const etag = r1.headers.get('etag');
  assert.ok(etag);
  const r2 = await worker.fetch(req('/v1/models', { headers: { 'if-none-match': etag } }), { CATALOG: kv }, ctxFactory().ctx);
  assert.equal(r2.status, 304);
});

test('HEAD returns headers, no body', async () => {
  globalThis.caches = { default: fakeCache() };
  const kv = fakeKV();
  await kv.put('/v1/models', MODELS_JSON, { metadata: {} });
  const res = await worker.fetch(req('/v1/models', { method: 'HEAD' }), { CATALOG: kv }, ctxFactory().ctx);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '');
});

test('OPTIONS preflight -> 204 CORS', async () => {
  globalThis.caches = { default: fakeCache() };
  const res = await worker.fetch(req('/v1/models', { method: 'OPTIONS' }), {}, ctxFactory().ctx);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-methods'), 'GET, HEAD, OPTIONS');
});

test('POST -> 405', async () => {
  globalThis.caches = { default: fakeCache() };
  const res = await worker.fetch(req('/v1/models', { method: 'POST' }), {}, ctxFactory().ctx);
  assert.equal(res.status, 405);
});

test('unknown path -> 404 with available list', async () => {
  globalThis.caches = { default: fakeCache() };
  const res = await worker.fetch(req('/v1/nope'), {}, ctxFactory().ctx);
  assert.equal(res.status, 404);
  assert.ok((await res.json()).available.includes('/v1/models'));
});

test('origin down + empty KV -> bundled snapshot fallback (never empty)', async () => {
  globalThis.caches = { default: fakeCache() };
  installFetch({ [MODELS_URL]: new Error('origin unreachable') });
  const res = await worker.fetch(req('/v1/models'), { CATALOG: fakeKV() }, ctxFactory().ctx);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-catalog-source'), 'snapshot');
  const body = await res.json();
  assert.equal(body.data.length, SNAPSHOT['/v1/models'].data.length);
});

test('origin returns HTML error page -> rejected, snapshot fallback', async () => {
  globalThis.caches = { default: fakeCache() };
  installFetch({ [MODELS_URL]: { body: '<html>502</html>' } });
  const res = await worker.fetch(req('/v1/models'), { CATALOG: fakeKV() }, ctxFactory().ctx);
  assert.equal(res.headers.get('x-catalog-source'), 'snapshot');
});

test('scheduled refresh populates KV + manifest for every resource', async () => {
  globalThis.caches = { default: fakeCache() };
  installFetch({
    'https://pricing.hanzo.ai/v1/models': { body: MODELS_JSON },
    'https://pricing.hanzo.ai/v1/pricing': { body: '{"ok":true}' },
  });
  const kv = fakeKV();
  const manifest = await worker.scheduled({}, { CATALOG: kv }, ctxFactory().ctx);
  assert.equal(manifest.results['/v1/models'].ok, true);
  assert.equal(manifest.results['/v1/pricing'].ok, true);
  assert.equal(kv.store.get('/v1/models').value, MODELS_JSON);
  assert.ok(kv.store.get('__manifest'));
});

// ONE ADDRESS, ONE ANSWER. A token used to make this worker proxy /v1/models and
// /v1/pricing to api.cloud.hanzo.ai, so one URL returned two different documents
// depending on a header — a shape no OpenAPI document can express and no SDK can
// predict. catalog.hanzo.ai is public browsing and only that; the authenticated
// view lives at api.hanzo.ai, served by the origin that describes it.
test('a token changes nothing: the public cache answers, no upstream is dialled', async () => {
  globalThis.caches = { default: fakeCache() };
  const kv = fakeKV();
  await kv.put('/v1/models', MODELS_JSON, { metadata: {} });
  installFetch({}); // any outbound fetch would throw "unexpected fetch"
  const res = await worker.fetch(req('/v1/models', { headers: { authorization: 'Bearer tok' } }), { CATALOG: kv }, ctxFactory().ctx);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-catalog-source'), 'kv');
  assert.equal(await res.text(), MODELS_JSON);
});

test('scheduled refresh records per-origin failure without aborting others', async () => {
  globalThis.caches = { default: fakeCache() };
  installFetch({
    'https://pricing.hanzo.ai/v1/models': { body: MODELS_JSON },
    'https://pricing.hanzo.ai/v1/pricing': new Error('boom'),
  });
  const manifest = await worker.scheduled({}, { CATALOG: fakeKV() }, ctxFactory().ctx);
  assert.equal(manifest.results['/v1/models'].ok, true);
  assert.equal(manifest.results['/v1/pricing'].ok, false);
});
