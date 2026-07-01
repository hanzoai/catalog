/**
 * Hanzo Public Catalog — Cloudflare edge-cached, daily-refreshed PUBLIC read-only
 * catalog (models, pricing, plans; extensible via src/registry.js).
 *
 * Why: cloud-api (api.hanzo.ai) is fully authenticated. Public-consumption catalog
 * data (marketing site, pre-login model browsing, docs) is served from HERE — a CF
 * edge cache in front of the canonical pricing service — so it is fast, global, and
 * never requires a token. Traefik splits `api.hanzo.ai/v1/{models,pricing}` (no auth
 * header) to this worker; authenticated + all other /v1 continue to the gateway.
 *
 * Serving order (never empty): CF Cache API (edge) -> KV (durable) -> origin
 * (read-through) -> bundled snapshot. Cache-Control carries stale-while-revalidate;
 * a daily cron re-fetches every registry origin and warms KV + the edge cache.
 */
import { REGISTRY, PATHS, CATALOG_ORIGIN } from './registry.js';
import SNAPSHOT from './snapshot.js';

// 1h browser, 24h shared edge, serve stale up to 24h while revalidating.
const CACHE_CONTROL = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400';
const ORIGIN_TIMEOUT_MS = 10_000;
const CANONICAL_HOST = 'https://catalog.hanzo.ai';

const corsHeaders = () => ({
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-max-age': '86400',
});

// Cheap, sync, stable weak ETag (djb2 over the body).
function etagOf(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return `W/"${text.length.toString(36)}-${h.toString(36)}"`;
}

function keyFor(path) {
  return new Request(new URL(path, CANONICAL_HOST).toString(), { method: 'GET' });
}

function jsonResponse(obj, { status = 200, cache = false } = {}) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    ...corsHeaders(),
  };
  if (cache) headers['cache-control'] = CACHE_CONTROL;
  return new Response(JSON.stringify(obj), { status, headers });
}

function catalogResponse(text, { etag, updated, source }) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': CACHE_CONTROL,
    'x-content-type-options': 'nosniff',
    etag,
    vary: 'accept-encoding',
    ...corsHeaders(),
  };
  if (updated) headers['x-catalog-updated'] = updated;
  if (source) headers['x-catalog-source'] = source;
  return new Response(text, { status: 200, headers });
}

async function fetchOrigin(path) {
  const { origin } = REGISTRY[path];
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ORIGIN_TIMEOUT_MS);
  try {
    const res = await fetch(origin, {
      headers: { accept: 'application/json' },
      signal: ac.signal,
      cf: { cacheTtl: 0 },
    });
    if (!res.ok) throw new Error(`origin ${origin} -> HTTP ${res.status}`);
    const text = await res.text();
    JSON.parse(text); // reject non-JSON / error pages before caching them
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function putKV(env, path, text, meta) {
  if (env && env.CATALOG) await env.CATALOG.put(path, text, { metadata: meta });
}

// Authenticated pass-through to cloud-api. Never cached (per-user) and never falls
// back to the public cache — a token must get cloud-api's real answer (incl. its
// errors). This is the auth-branch the ingress fork can't express (no HeadersRegexp).
async function proxyAuthed(request, url, authedOrigin) {
  const target = new URL(authedOrigin);
  target.search = url.search;
  const fwd = new Headers();
  for (const h of ['authorization', 'accept', 'content-type']) {
    const v = request.headers.get(h);
    if (v) fwd.set(h, v);
  }
  const method = request.method;
  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      method,
      headers: fwd,
      body: method === 'GET' || method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
      cf: { cacheTtl: 0 },
    });
  } catch (e) {
    return jsonResponse({ error: { message: `authed upstream unreachable: ${String((e && e.message) || e)}`, type: 'upstream_error' } }, { status: 502 });
  }
  const headers = new Headers(upstream.headers);
  headers.set('cache-control', 'private, no-store');
  headers.set('x-catalog-source', 'cloud-api');
  headers.set('access-control-allow-origin', '*');
  return new Response(method === 'HEAD' ? null : upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

// KV (durable) -> origin (read-through, persisted) -> bundled snapshot.
async function resolve(path, env, ctx) {
  if (env && env.CATALOG) {
    const { value, metadata } = await env.CATALOG.getWithMetadata(path, { type: 'text' });
    if (value) {
      return { text: value, source: 'kv', updated: metadata?.updated, etag: metadata?.etag || etagOf(value) };
    }
  }
  try {
    const text = await fetchOrigin(path);
    const updated = new Date().toISOString();
    const etag = etagOf(text);
    const write = putKV(env, path, text, { updated, etag });
    if (ctx && ctx.waitUntil) ctx.waitUntil(write); else await write;
    return { text, source: 'origin', updated, etag };
  } catch (_) {
    /* fall through to snapshot */
  }
  if (Object.prototype.hasOwnProperty.call(SNAPSHOT, path)) {
    const text = JSON.stringify(SNAPSHOT[path]);
    return { text, source: 'snapshot', updated: SNAPSHOT.__generated, etag: etagOf(text) };
  }
  return null;
}

async function serveResource(path, request, env, ctx) {
  const cache = caches.default;
  const cacheKey = keyFor(path);

  const cached = await cache.match(cacheKey);
  if (cached) return finish(cached, request, 'hit');

  const r = await resolve(path, env, ctx);
  if (!r) return jsonResponse({ error: { message: `catalog resource unavailable: ${path}`, type: 'upstream_error' } }, { status: 502 });

  const resp = catalogResponse(r.text, r);
  const store = cache.put(cacheKey, resp.clone());
  if (ctx && ctx.waitUntil) ctx.waitUntil(store); else await store;
  return finish(resp, request, 'miss');
}

// Apply conditional (304), cache-status header, and HEAD semantics.
function finish(resp, request, cacheStatus) {
  const etag = resp.headers.get('etag');
  const inm = request.headers.get('if-none-match');
  const headers = new Headers(resp.headers);
  headers.set('x-catalog-cache', cacheStatus);

  if (etag && inm && inm === etag) {
    return new Response(null, { status: 304, headers });
  }
  if (request.method === 'HEAD') {
    return new Response(null, { status: resp.status, headers });
  }
  return new Response(resp.body, { status: resp.status, headers });
}

async function index(env) {
  let refreshed = null;
  try {
    if (env && env.CATALOG) {
      const m = await env.CATALOG.get('__manifest', { type: 'json' });
      refreshed = m?.refreshedAt || null;
    }
  } catch (_) { /* best-effort */ }
  return jsonResponse({
    service: 'hanzo-public-catalog',
    description: 'Cloudflare edge-cached, daily-refreshed public read-only catalog.',
    origin: CATALOG_ORIGIN,
    refreshed,
    resources: PATHS.map((p) => ({ path: p, description: REGISTRY[p].description })),
  });
}

// Daily cron: re-fetch every registry origin, persist to KV, warm the edge cache.
async function refresh(env) {
  const cache = caches.default;
  const results = {};
  for (const path of PATHS) {
    try {
      const text = await fetchOrigin(path);
      const updated = new Date().toISOString();
      const etag = etagOf(text);
      await putKV(env, path, text, { updated, etag });
      await cache.put(keyFor(path), catalogResponse(text, { etag, updated, source: 'cron' }));
      results[path] = { ok: true, bytes: text.length, updated };
    } catch (e) {
      results[path] = { ok: false, error: String((e && e.message) || e) };
    }
  }
  const manifest = { refreshedAt: new Date().toISOString(), origin: CATALOG_ORIGIN, results };
  if (env && env.CATALOG) await env.CATALOG.put('__manifest', JSON.stringify(manifest));
  return manifest;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const registered = Object.prototype.hasOwnProperty.call(REGISTRY, path);

    // Authenticated caller on a mirrored path -> proxy to authed cloud-api (any
    // method), so a token yields cloud-api's own view, never the public cache.
    if (registered && REGISTRY[path].authedOrigin && request.headers.get('authorization')) {
      return proxyAuthed(request, url, REGISTRY[path].authedOrigin);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonResponse({ error: { message: 'method not allowed', type: 'method_not_allowed' } }, { status: 405 });
    }

    if (path === '/' || path === '') return index(env);
    if (path === '/health') return jsonResponse({ status: 'ok' });
    if (path === '/__manifest') {
      const m = (env && env.CATALOG) ? await env.CATALOG.get('__manifest', { type: 'json' }) : null;
      return jsonResponse(m || { refreshedAt: null, results: {} });
    }
    if (registered) {
      return serveResource(path, request, env, ctx);
    }
    return jsonResponse({ error: { message: `not found: ${path}`, type: 'not_found' }, available: PATHS }, { status: 404 });
  },

  async scheduled(event, env, ctx) {
    const run = refresh(env);
    if (ctx && ctx.waitUntil) ctx.waitUntil(run);
    return run;
  },
};

// Exported for tests.
export { etagOf, resolve, refresh, fetchOrigin, catalogResponse, proxyAuthed };
