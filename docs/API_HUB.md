# ABxAG API Hub

The API Hub imports the community-maintained [public-apis catalogue](https://github.com/public-apis/public-apis) without exposing every provider as a model tool.

## Runtime flow

1. On startup, ABxAG loads the last validated registry from the writable data directory.
2. If the cache is stale, a background sync fetches the configured catalogue.
3. The Markdown importer validates table structure, normalizes auth/HTTPS/CORS metadata, removes duplicate documentation URLs, and atomically replaces the cache only when the result passes a minimum-size guard.
4. Capability search ranks a small relevant provider set. Catalogue presence is not treated as endpoint verification.
5. Bounded health checks test one selected documentation URL at a time.
6. Only pre-verified declarative adapters may call providers. Adapters cannot contain or execute code.

Provider states are `READY_NO_AUTH`, `NEEDS_API_KEY`, `NEEDS_OAUTH`, `BROKEN`, `UNSUPPORTED`, and `UNKNOWN`. Health state is tracked separately so a temporary documentation failure does not immediately discard a provider; two consecutive hard failures are required before `BROKEN` is assigned.

## Adapter safety

Adapters are JSON-shaped specifications restricted to GET/POST, scalar parameters, public HTTP(S) destinations, short timeouts, bounded redirects, bounded JSON responses, optional environment-variable credential references, and restricted JSON-path output mappings. Private/loopback literal addresses, URL credentials, downloaded code, arbitrary expressions, and unverified adapters are rejected.

The initial verified adapters are:

- `weather.open-meteo.current.v1`
- `space.launch-library.upcoming.v1`

## Local APIs

- `GET /api/api-hub/status`
- `GET /api/api-hub/search?q=weather`
- `GET /api/api-hub/providers`
- `POST /api/api-hub/sync`
- `POST /api/api-hub/providers/:providerId/health`
- `GET /api/api-hub/adapters`
- `POST /api/api-hub/adapters/:adapterId/call`

Mutable registry and adapter data live under `api-hub/` inside ABxAG's existing per-user data directory. Credentials are never stored in the catalogue or adapter files and are never returned by these endpoints.

