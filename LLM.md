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
| `GET /` | Self-describing index (resources + last refresh) |
| `GET /health` | `{status:"ok"}` |
| `GET /__manifest` | Last cron result per resource |

All public, no auth, CORS `*`, `Cache-Control: public, max-age=3600, s-maxage=86400,
stale-while-revalidate=86400`, ETag + `If-None-Match` 304, `HEAD`/`OPTIONS`.

## Architecture (one way, decomplected)

- **Canonical origin** = `api.hanzo.ai` — cloud computes the catalog in Go
  (`apps/pricing`). This worker is a **CF edge cache in front of it**, so public
  browsing is fast/global and survives a slow origin. No service token (the
  catalog paths are public).
- **Serving order (never empty):** CF Cache API (edge) → KV `CATALOG` (durable) →
  origin (read-through, persisted) → bundled `src/snapshot.js` fallback.
- **Daily refresh:** cron `0 6 * * *` re-fetches every registry origin, writes KV, warms
  the edge cache. Writes `__manifest`.
- **Registry = one place:** `src/registry.js`. Add a line to expose a new resource; the
  worker and the snapshot generator both read it.

## Routing — this worker serves `catalog.hanzo.ai`, and nothing else

One host, owned outright (`wrangler.toml` `custom_domain`). Public consumers —
marketing, pre-login model browsing, docs — read it directly, at the nearest CF edge.

**It used to also answer `api.hanzo.ai/v1/{models,pricing}`,** via a Traefik router
(`universe/infra/k8s/ingress/routes.yaml`, `api-hanzo-ai-catalog`, priority 200) that
path-carved those prefixes off the API host. That router is deleted, because a second
implementation at an address the cloud origin publishes cannot be described by anything:

- all 23 of cloud `apps/pricing`'s `/v1/pricing*` paths were published and unreachable —
  14 of the 21 literal GETs answered this worker's own 404 (the registry holds 10
  addresses; the document holds 23, and they overlap in 7);
- `GET`/`POST /v1/models/{model}/access` (hanzoai/ai) were uncallable in production —
  404 on GET, 405 on POST, since this worker allows only `GET, HEAD, OPTIONS`;
- `/v1/models` returned the marketing catalog to anonymous callers and cloud's
  callable-model list to token holders. One address, two documents, chosen by a header
  no OpenAPI document can express and no SDK can predict. That `authedOrigin` fork and
  its `api.cloud.hanzo.ai` second API host are gone with it.

api.hanzo.ai is the API and the cloud origin owns every path on it. A carve off that
host must not overlap a path cloud publishes — the rule is stated at `routes.yaml`,
where carves are written.

## Develop / deploy

```bash
npm test                 # node --test, stubbed KV/Cache/fetch
npm run snapshot         # regenerate src/snapshot.js from api.hanzo.ai
npx wrangler deploy      # deploy worker + custom domain + cron (global key auth)
```

CF: account `94a3e3f299092abb1feda2a7481ea845`, zone `hanzo.ai`, KV `CATALOG`
`9cffb94fd2da4a2b80b36e541250a655`. Auth via `~/.hanzo/credentials.env` global key.

## Add a resource

1. Add a line to `src/registry.js` (`publicPath → { origin, description }`).
2. `npm run snapshot && npm test && npx wrangler deploy`.

A resource that must answer on `api.hanzo.ai` does not belong here — it belongs in
the cloud origin, which publishes it in the one document.
