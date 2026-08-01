# Hanzo Public Catalog

Cloudflare edge-cached, daily-refreshed **public** read-only catalog for Hanzo.
Serves the model + pricing catalog to public consumers (marketing site, pre-login
model browsing, docs) without a token, so `api.hanzo.ai` can stay fully authenticated.

Live: **https://catalog.hanzo.ai**

```bash
curl https://catalog.hanzo.ai/v1/models    # OpenAI-compatible model catalog
curl https://catalog.hanzo.ai/v1/pricing   # full pricing catalog
curl https://catalog.hanzo.ai/v1/plans     # subscription / cloud plans
curl https://catalog.hanzo.ai/             # self-describing index
```

This is the only host it serves. `api.hanzo.ai` is the authenticated API and the cloud
origin owns every path on it — including `/v1/models` and `/v1/pricing/*`, which this
worker used to intercept at the ingress. See [`LLM.md`](./LLM.md) for what that cost.

See [`LLM.md`](./LLM.md) for architecture, the resource registry, routing, and how to
add a new cached resource.
