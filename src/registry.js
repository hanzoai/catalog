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
 *   publicPath  the stable public URL path this worker serves, on
 *               catalog.hanzo.ai — the host this worker owns outright.
 *   origin      the canonical upstream URL the daily cron refreshes from.
 *
 * These paths are served HERE and nowhere else. api.hanzo.ai is the API and its
 * owner is the cloud origin; it used to path-carve /v1/models* + /v1/pricing* to
 * this worker, which dark-holed 23 published pricing routes and made
 * /v1/models/{model}/access uncallable. That carve is gone (hanzoai/universe
 * infra/k8s/ingress/routes.yaml). One address, one implementation, each side of
 * the boundary: public browsing here, the authenticated API there.
 */
export const CATALOG_ORIGIN = 'https://pricing.hanzo.ai';

export const REGISTRY = {
  '/v1/models': {
    origin: `${CATALOG_ORIGIN}/v1/models`,
    description: 'OpenAI-compatible model catalog: { object:"list", data:[...] } plus families + summary.',
  },
  '/v1/pricing': {
    origin: `${CATALOG_ORIGIN}/v1/pricing`,
    description: 'Full pricing catalog: per-model input/output pricing, providers, free + featured models.',
  },
  '/v1/plans': {
    origin: `${CATALOG_ORIGIN}/v1/plans`,
    description: 'Subscription / cloud plans.',
  },
  // Infrastructure pricing sub-resources. Cloud + GPU keep their upstream
  // top-level origins (/v1/cloud, /v1/gpu) — the public path is namespaced, the
  // origin is not.
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
