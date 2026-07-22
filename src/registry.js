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
  // Infrastructure pricing sub-resources. Namespaced under /v1/pricing/* so the
  // one existing api.hanzo.ai catalog router (PathPrefix /v1/pricing) fronts them
  // with no new Traefik rule. Cloud + GPU keep their upstream top-level origins
  // (/v1/cloud, /v1/gpu) — the public path is namespaced, the origin is not.
  '/v1/pricing/cloud': {
    origin: `${CATALOG_ORIGIN}/v1/cloud`,
    description: 'Cloud compute pricing (instances, vCPU/RAM/disk tiers).',
  },
  '/v1/pricing/gpu': {
    origin: `${CATALOG_ORIGIN}/v1/gpu`,
    description: 'GPU pricing (upstream serves this at /v1/gpu).',
  },
  '/v1/pricing/datastore': {
    origin: `${CATALOG_ORIGIN}/v1/pricing/datastore`,
    description: 'Datastore / managed-storage pricing.',
  },
  '/v1/pricing/cloud/plans': {
    origin: `${CATALOG_ORIGIN}/v1/pricing/cloud/plans`,
    description: 'Cloud subscription plans.',
  },
  '/v1/pricing/cloud/regions': {
    origin: `${CATALOG_ORIGIN}/v1/pricing/cloud/regions`,
    description: 'Cloud regions.',
  },
  '/v1/pricing/cloud/storage': {
    origin: `${CATALOG_ORIGIN}/v1/pricing/cloud/storage`,
    description: 'Cloud block/object storage pricing.',
  },
  '/v1/pricing/summary': {
    origin: `${CATALOG_ORIGIN}/v1/pricing/summary`,
    description: 'Pricing summary rollup.',
  },
};

export const PATHS = Object.keys(REGISTRY);
