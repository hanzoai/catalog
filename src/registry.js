/**
 * Public catalog registry — the ONE place that declares what read-only,
 * public-consumption data the edge caches. Add a line to expose a new resource;
 * the worker (serving + daily cron) and the snapshot generator both read this.
 *
 * Canonical origin = the Hanzo pricing service (hanzoai/pricing, pricing.hanzo.ai):
 * a public, CORS-enabled aggregator that is already the source of truth for the
 * model + pricing catalog. It stays the origin; this layer is a CF edge cache in
 * front of it so public browsing is fast, global, and resilient to the origin.
 *
 * Each entry: publicPath -> { origin, description }.
 *   publicPath  the stable public URL path this worker serves (and that Traefik
 *               splits from api.hanzo.ai to here).
 *   origin      the canonical upstream URL the daily cron refreshes from.
 */
export const CATALOG_ORIGIN = 'https://pricing.hanzo.ai';

// Authenticated callers on a path that also exists on cloud-api are proxied there
// (so a token still yields cloud-api's own view — e.g. its callable-model list — not
// the public marketing catalog). Anonymous callers get the edge cache. This is how
// "public consumers -> CF cache; authenticated tenants -> authed cloud-api" is
// honored, since the ingress fork can't branch on the Authorization header itself.
export const AUTHED_ORIGIN = 'https://api.cloud.hanzo.ai';

export const REGISTRY = {
  '/v1/models': {
    origin: `${CATALOG_ORIGIN}/v1/models`,
    authedOrigin: `${AUTHED_ORIGIN}/v1/models`,
    description: 'OpenAI-compatible model catalog: { object:"list", data:[...] } plus families + summary.',
  },
  '/v1/pricing': {
    origin: `${CATALOG_ORIGIN}/v1/pricing`,
    authedOrigin: `${AUTHED_ORIGIN}/v1/pricing`,
    description: 'Full pricing catalog: per-model input/output pricing, providers, free + featured models.',
  },
  '/v1/plans': {
    origin: `${CATALOG_ORIGIN}/v1/plans`,
    description: 'Subscription / cloud plans.',
  },
};

export const PATHS = Object.keys(REGISTRY);
