# hanzo-public-catalog

Cloudflare Worker: an edge-cached, daily-refreshed **public** read-only catalog for
Hanzo's public-consumption data (models, pricing, plans; extensible). Lets cloud-api
(`api.hanzo.ai`) stay **fully authenticated** — public browsing is served from here,
not from an auth-bypass allowlist.

## What it serves (host: `catalog.hanzo.ai`, CF-proxied)

| Path | Content |
|------|---------|
| `GET /v1/models` | OpenAI-compatible model catalog (`{object:"list", data:[...]}` + families + summary) |
| `GET /v1/pricing` | Full pricing catalog (per-model input/output, providers, free/featured) |
| `GET /v1/plans` | Subscription / cloud plans |
| `GET /` | Self-describing index (resources + last refresh) |
| `GET /health` | `{status:"ok"}` |
| `GET /__manifest` | Last cron result per resource |

All public, no auth, CORS `*`, `Cache-Control: public, max-age=3600, s-maxage=86400,
stale-while-revalidate=86400`, ETag + `If-None-Match` 304, `HEAD`/`OPTIONS`.

## Architecture (one way, decomplected)

- **Canonical origin** = `hanzoai/pricing` (`pricing.hanzo.ai`) — the public catalog
  aggregator. This worker is a **CF edge cache in front of it**, so public browsing is
  fast/global and resilient to the origin. No service token (origin is public).
- **Serving order (never empty):** CF Cache API (edge) → KV `CATALOG` (durable) →
  origin (read-through, persisted) → bundled `src/snapshot.js` fallback.
- **Daily refresh:** cron `0 6 * * *` re-fetches every registry origin, writes KV, warms
  the edge cache. Writes `__manifest`.
- **Registry = one place:** `src/registry.js`. Add a line to expose a new resource; the
  worker and the snapshot generator both read it.

## Routing (`api.hanzo.ai/v1/{models,pricing}` → here)

`api.hanzo.ai` is DNS-only (not CF-proxied) so streaming LLM traffic never transits CF.
The catalog paths are split at Traefik — `universe/infra/k8s/ingress/routes.yaml`, router
`api-hanzo-ai-catalog` (priority 200):
`Host(api.hanzo.ai) && (PathPrefix(/v1/models) || PathPrefix(/v1/pricing))` → service
`public-catalog` (→ `https://catalog.hanzo.ai`, `passHostHeader: false` so CF matches the
worker's custom domain). Priority 200 beats the catch-all (1) and the k8s Host-only
ingresses (computed priority).

The auth-branch lives in the **worker**, not Traefik — the `hanzoai/ingress` fork can't
match on a header (no `HeadersRegexp`; single-arg `Method`). A request WITH an
`Authorization` header on a mirrored path is proxied by the worker to `api.cloud.hanzo.ai`
(→ gateway → cloud-api), so a token gets cloud-api's own view (its callable-model list);
anonymous GETs get the edge cache. See `authedOrigin` in `src/registry.js`.

Consumers should prefer `catalog.hanzo.ai` directly (nearest CF edge). The api.hanzo.ai
path is a compat alias.

## Develop / deploy

```bash
npm test                 # node --test, stubbed KV/Cache/fetch
npm run snapshot         # regenerate src/snapshot.js from pricing.hanzo.ai
npx wrangler deploy      # deploy worker + custom domain + cron (global key auth)
```

CF: account `94a3e3f299092abb1feda2a7481ea845`, zone `hanzo.ai`, KV `CATALOG`
`9cffb94fd2da4a2b80b36e541250a655`. Auth via `~/.hanzo/credentials.env` global key.

## Add a resource

1. Add a line to `src/registry.js` (`publicPath → { origin, description }`).
2. `npm run snapshot && npm test && npx wrangler deploy`.
3. (If it must also answer on `api.hanzo.ai`) add its `PathPrefix` to the Traefik
   `api-hanzo-ai-catalog` router rule. Set `authedOrigin` if a token should get
   cloud-api's own view of that path instead of the public cache.
