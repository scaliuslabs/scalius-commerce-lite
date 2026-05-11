# Audit Agent 08 - Public API Surface

## Scope

- Owned surface: `apps/api/src/app.ts`, `apps/api/src/worker.ts`, all non-`admin/` route files under `apps/api/src/routes/`, plus middleware/utilities/schemas needed to verify request validation, response envelopes, caching, and public attack surface.
- Cross-checks used for impact verification: generated SDK/types in `packages/api-client`, storefront callers in `apps/storefront`, and the `hono-cf` plus `workers-best-practices` skills.
- Out of scope except where needed to prove route behavior: deep internals of `@scalius/core` domain services and admin route business logic.

## How The Public API Works End To End

1. `apps/api/src/worker.ts` exposes the Hono app through a `WorkerEntrypoint` fetch handler and also owns queue + cron entrypoints. Public HTTP traffic reaches `app.fetch(request, this.env, this.ctx)` directly.
2. `apps/api/src/app.ts` builds a single `OpenAPIHono` app at base path `/api/v1`, initializes D1/KV/R2 bindings per request, applies dynamic CORS, app-level security headers, and a JSON-only global error handler.
3. Public/storefront routes are mounted directly on the base app before any auth middleware, including content APIs, storefront config APIs, checkout/customer auth, checkout languages, payment session creation, public webhooks, the Partytown proxy, docs, and OpenAPI JSON.
4. Only a small subset is guarded:
   - `/orders/*` uses `authMiddleware` with JWT bearer tokens.
   - `/cache/*` uses `adminAuthMiddleware`.
   - Webhooks intentionally bypass auth and rely on signature verification instead.
5. Storefront SSR uses `apps/storefront/src/lib/api/client.ts` to obtain a JWT from `GET /api/v1/auth/token` using `X-API-Token`, then reuses that bearer token for server-side API calls. Checkout proxy routes in `apps/storefront/src/pages/api/checkout/*.ts` forward browser JSON payloads to payment session endpoints and unwrap the `{ success, data }` envelope before returning data to the browser.
6. OpenAPI schemas in route files drive the generated SDK in `packages/api-client`, so schema/handler mismatches do not stay local; they propagate into generated client types and docs.

## Findings

### P0 - Public checkout-language CRUD is mounted without auth

- Public routing mounts the entire checkout-language router at `/api/v1/checkout-languages` in `apps/api/src/app.ts:205`, while the same router is also mounted under the admin prefix at `apps/api/src/app.ts:300`.
- The shared router includes unauthenticated mutation endpoints for create, update, soft-delete, hard-delete, and restore in `apps/api/src/routes/checkout-languages.ts:231-449`.
- The generated SDK exposes the public write routes as first-class operations in `packages/api-client/src/generated/sdk.gen.ts:412-480`, so this is not just an obscure raw-HTTP edge.
- Impact: any internet client can create, replace, delete, or restore checkout language records and can also list/search all records, including trashed ones. Because these settings control checkout copy and field visibility, this is an admin-configuration takeover path on a storefront-critical surface.

### P1 - Payment session endpoints are internet-reachable, mutate orders by ID, and SSLCommerz lets callers control callback/IPN origins

- `apps/api/src/app.ts:306-309` mounts all payment session routes publicly.
- The storefront proxies are written as internal/server-side façades and forward the browser payload through unchanged:
  - `apps/storefront/src/pages/api/checkout/stripe-intent.ts:7-18`
  - `apps/storefront/src/pages/api/checkout/sslcommerz-session.ts:7-18`
  - `apps/storefront/src/pages/api/checkout/polar-session.ts:7-18`
- Despite that, the API routes themselves do not require service auth or per-order ownership proof:
  - Stripe mutates `orders.paymentIntentId` and may create a `paymentPlans` row in `apps/api/src/routes/payment/stripe-routes.ts:136-153`
  - SSLCommerz mutates `orders.paymentIntentId` and may create a `paymentPlans` row in `apps/api/src/routes/payment/sslcommerz-routes.ts:145-165`
  - Polar mutates `orders.paymentIntentId` and may upsert a `paymentPlans` row in `apps/api/src/routes/payment/polar-routes.ts:175-208`
- SSLCommerz is worse because the public request body accepts `baseUrl` in `apps/api/src/routes/payment/sslcommerz-routes.ts:19-25`, and that value is then used to build `successUrl`, `failUrl`, `cancelUrl`, and `ipnUrl` in `apps/api/src/routes/payment/sslcommerz-routes.ts:117-132`.
- Impact:
  - anyone who knows an `orderId` can create/overwrite payment session state on that order;
  - a caller can steer SSLCommerz callbacks and IPN traffic to an arbitrary host, breaking payment completion and leaking gateway callback payloads away from the real API.

### P1 - `GET /auth/token` can fail in Workers because it signs with `process.env`, not `c.env`

- The public service-token endpoint is defined in `apps/api/src/routes/auth.ts:44-80`.
- It calls `generateToken(...)` without passing the worker env at `apps/api/src/routes/auth.ts:73-80`.
- `generateToken()` resolves the secret from `env?.JWT_SECRET` first, then falls back to `process.env.JWT_SECRET` in `apps/api/src/utils/jwt.ts:36-58`.
- In Workers, the canonical secret source is the runtime binding, not `process.env`; the `hono-cf` and `workers-best-practices` guidance both point to `c.env`/generated `Env` bindings as the supported pattern.
- Storefront SSR depends on this endpoint for authenticated server-side API calls in `apps/storefront/src/lib/api/client.ts:80-110`.
- Impact: if `JWT_SECRET` is present only as a worker secret binding, `/auth/token` can throw instead of issuing a JWT, which would break any service-binding flow that relies on `fetchWithRetry(..., requiresAuth=true)`.

### P2 - Hero slider caching ignores the device variant and can serve the wrong homepage hero

- The hero route is cached by path only in `apps/api/src/routes/hero.ts:19-27`.
- The handler changes behavior based on `User-Agent` in `apps/api/src/routes/hero.ts:71-74` and returns device-dependent payloads in `apps/api/src/routes/hero.ts:147-153`.
- No cache key variation or `Vary: User-Agent` header is added, so the first cached response can bleed across desktop/mobile clients.
- The storefront also edge-caches `getHeroSliders()` behind a single static key, `homepage_hero_sliders`, in `apps/storefront/src/lib/api/settings.ts:109-123`, which compounds the problem.
- Impact: desktop users can receive mobile hero images or vice versa, and the bad variant can persist in both API KV cache and storefront edge cache.

### P2 - OpenAPI/SDK contract drift on `GET /attributes/search-filters`

- The route-level response schema is declared as `successEnvelope(array(...))` in `apps/api/src/routes/attributes.ts:50` and then used for `/search-filters` in `apps/api/src/routes/attributes.ts:150-154`.
- The handler actually returns `{ success: true, data: { filters: [...] } }` in the empty-result branch at `apps/api/src/routes/attributes.ts:163-165` and again in the populated branch at `apps/api/src/routes/attributes.ts:243`.
- The generated SDK/types therefore claim `data` is an array in `packages/api-client/src/generated/types.gen.ts:583-596`.
- The storefront client already compensates for the real runtime shape by expecting `.filters` in `apps/storefront/src/lib/api/attributes.ts:48-57`.
- Impact: docs and generated types lie about the payload, which increases integration risk and can break any consumer that trusts the SDK type instead of reverse-engineering the runtime shape.

### P2 - Partytown proxy validates only the initial hostname, then follows redirects

- The allowlist check happens before the fetch in `apps/api/src/routes/partytown-proxy.ts:96-116`.
- The actual fetch uses `redirect: "follow"` in `apps/api/src/routes/partytown-proxy.ts:118-127`.
- That means any allowlisted host with an open redirect can be used to fetch arbitrary third-party content, and the proxy returns it with `Access-Control-Allow-Origin: *`.
- Impact: the route behaves more like a constrained open proxy than a strict allowlist proxy. This is a public attack surface issue even if the allowlist is normally small.

### P3 - `CACHE_TTLS.NONE` does not actually disable API caching

- The analytics route opts into `CACHE_TTLS.NONE` in `apps/api/src/routes/analytics.ts:17-24`.
- `CACHE_TTLS.NONE` is documented as `0` / “explicitly no caching” in `apps/api/src/utils/cache-ttls.ts:21-25`.
- The KV cache layer clamps all TTLs to at least 60 seconds in `apps/api/src/utils/kv-cache.ts:4-5` and `apps/api/src/utils/kv-cache.ts:128-131`.
- Impact: routes that believe they are uncached are still persisted in KV for at least 60 seconds. That is lower severity than the issues above, but it makes caching behavior non-obvious and undermines route-level intent.

## Contract Notes

- The app mostly follows the standard success envelope, but it is not universal:
  - `/api/v1/` and `/api/v1/health` return ad hoc JSON rather than `{ success, data }`.
  - Webhook routes return provider-specific shapes instead of the standard envelope.
  - `GET /attributes/search-filters` is the clearest schema/runtime mismatch and already leaks into generated SDK types.
- The generated SDK exposes public checkout-language mutations, which confirms that the public OpenAPI surface currently advertises those endpoints as supported public operations.
- `202 Accepted` responses are intentionally hand-built in the order polling flow (`apps/api/src/routes/orders.ts:186-188`, `apps/api/src/routes/orders.ts:332-344`) to preserve top-level `success: true`. That convention is consistent with the repo guidance.

## Caching Notes

- This API uses a custom KV-backed cache middleware, not the Cloudflare Cache API. That means response bodies are buffered with `clone().text()` and written to KV after the handler returns, rather than streamed or revalidated through edge cache semantics.
- The default `Cache-Control` string advertises `stale-while-revalidate` and `stale-if-error` in `apps/api/src/middleware/cache.ts:12-15`, but the middleware itself does not implement async revalidation logic; it only stores/replays serialized responses.
- Routes that vary by headers rather than URL/query are unsafe unless they explicitly vary the key. The hero slider route is the clearest current example.

## Security Notes

- The public setup endpoint exists at `/api/v1/setup` in `apps/api/src/app.ts:303-304`. The implementation has real first-admin guards, rate limiting, and a short creation lock in `apps/api/src/routes/admin/auth-management.ts:577-629`, so I do not consider it an immediate vulnerability, but it is still a privileged bootstrap surface exposed on the public app.
- `POST /api/v1/meta/events` is intentionally public in `apps/api/src/routes/meta-conversions.ts:81-141`, but it has no route-level auth or rate limiting. That is acceptable only if noisy or malicious event injection is considered tolerable.
- Customer auth relies on cross-site cookies for the API/storefront split. I did not find CSRF defenses in this owned route layer; if cross-origin write hardening matters, this deserves a dedicated follow-up audit.

## Prioritized Follow-Ups

1. Split `checkoutLanguageRoutes` into a read-only public router and an admin-only mutation router, or apply auth middleware to every non-GET public mutation immediately.
2. Lock payment session creation behind service auth or a per-order secret, and remove caller-controlled callback URL fields from public request bodies. For SSLCommerz specifically, derive callback/IPN URLs only from trusted server config.
3. Fix `/auth/token` to call `generateToken(..., ..., c.env)` and make the token-stats path use runtime env as well.
4. Make hero caching variant-safe: either remove UA-dependent behavior, add an explicit `type` query and cache on it, or add a safe `Vary`/cache-key strategy end to end.
5. Correct the `/attributes/search-filters` OpenAPI schema, regenerate the SDK, and align all consumers on one envelope shape.
6. Tighten the Partytown proxy by disabling redirect following or re-validating the final URL after redirects.
7. Align cache semantics so `CACHE_TTLS.NONE` truly bypasses KV persistence.

## Verification Notes

- Verified statically against the owned route files, generated SDK/types, and storefront callers.
- Started `pnpm --filter @scalius/api typecheck`, but it did not complete within the audit window, so the conclusions above are from code-path review rather than a completed workspace typecheck run.
