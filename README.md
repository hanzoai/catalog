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

The public `api.hanzo.ai/v1/models` and `api.hanzo.ai/v1/pricing` GETs (no auth) are
split to this cache at the ingress; authenticated calls go to cloud-api.

See [`LLM.md`](./LLM.md) for architecture, the resource registry, routing, and how to
add a new cached resource.
