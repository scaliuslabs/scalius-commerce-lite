# @scalius/api-client

The typed TypeScript SDK for the API Worker, generated from its OpenAPI contract. The dashboard (`apps/admin-v2`) and the storefront (`apps/storefront`) use it. This guide is for contributors.

The package is private and exports TypeScript source. It is not a published package and not a supported third-party SDK.

## Regenerate

Run this from the repository root after you change an API route schema or response, and commit the output:

```bash
pnpm generate:sdk
```

The script runs two steps:

1. `pnpm generate:agent-contract` loads the API app and finalizes the OpenAPI contract. It writes `apps/api/src/generated/agent-operations.gen.ts`, `apps/api/src/generated/openapi-contract.gen.ts` (served at `GET /api/v1/openapi.json`) and `packages/cli/src/generated/workflow-resolver-core.gen.ts`.
2. The `generate` task of this package (`pnpm --filter @scalius/api-client generate`) runs `scripts/generate-spec.ts`, then `openapi-ts`.
   - `generate-spec.ts` imports the API app and writes `openapi.json` (if the import fails, it fetches `http://localhost:8787/api/v1/openapi.json` from a running API). It drops the local-only `/api/v1/media/{key}` route, normalizes nullable unions, and fails when a path uses `:param` instead of `{param}`.
   - `openapi-ts` reads `openapi.json` and writes `src/generated/**`.

Never edit `src/generated/**` or `openapi.json` by hand. Only routes defined with `createRoute()` from `@hono/zod-openapi` appear in the contract. Routes registered with plain Hono methods do not.

## Files

- `openapi.json` is the checked-in OpenAPI 3.0 contract and the generator input. `openapi-ts.config.ts` configures `@hey-api/typescript`, `@hey-api/sdk` (`auth: false`) and a bundled `@hey-api/client-fetch`.
- `src/generated/` holds the request and response types (`types.gen.ts`), one SDK function per operation (`sdk.gen.ts`) and the default client (`client.gen.ts`, `client/`, `core/`).
- `src/client-factory.ts` (service binding or HTTP client) and `src/index.ts` (root barrel) are hand-written.

`auth: false` means no per-call security schemes: each consumer authenticates in its own transport (the dashboard with its session cookie, the storefront with its derived token).

## Exports

| Import | Provides |
| --- | --- |
| `@scalius/api-client` | Everything below, except the `Client` and `Config` types |
| `@scalius/api-client/types` | Request and response types |
| `@scalius/api-client/sdk` | SDK functions |
| `@scalius/api-client/client` | `client` (the default instance) and the `CreateClientConfig` type |
| `@scalius/api-client/factory` | `createServiceBindingClient`, `createHttpClient`, `createClient`, `createConfig` and the `Client`, `Config`, `ServiceBindingOptions` and `HttpOptions` types |

## Use the SDK

A function name comes from the HTTP method and the path: `getApiV1AdminProducts`, `getApiV1AdminCategoriesById` (`{id}` becomes `ById`). Renaming a path renames its function. The SDK does not use `operationId`.

A call takes `{ path, query, body, headers, client, throwOnError }` and returns `{ data, error, request, response }`. Omit `client` to use the default instance.

```typescript
import { createClient, createConfig } from "@scalius/api-client/factory";
import { getApiV1ProductsSearch } from "@scalius/api-client/sdk";

const client = createClient(createConfig({ baseUrl: "http://localhost:8787" }));
const { data } = await getApiV1ProductsSearch({
  client,
  query: { search: "shirt", page: 1, limit: 20 },
});
```

Types follow the same naming: `GetApiV1AdminProductsData` is the input, `GetApiV1AdminProductsResponses` maps status codes to bodies and `GetApiV1AdminProductsResponse` is their union.

### Envelope

The API answers `{ success, data }`, and the generated types keep that envelope. The SDK does not unwrap it. Each app unwraps once:

- The dashboard calls `apiData()` in `apps/admin-v2/src/lib/api.ts`. It returns `data` and throws `AdminApiResponseError` on failure.
- The storefront calls `unwrapEnvelope()` or `unwrapData()` in `apps/storefront/src/lib/api/unwrap.ts`.

### Client factory

`createServiceBindingClient({ serviceBinding: env.BACKEND_API, headers })` sends requests through a Cloudflare service binding to the fixed origin `https://api.internal`. `createHttpClient({ baseUrl, headers })` uses standard `fetch`. The factory never mints credentials: the caller supplies the headers the operation needs.

To control `fetch` yourself, pass it to `createConfig({ baseUrl, fetch })`, as `apps/storefront/src/lib/api/transport.ts` does. The dashboard configures the default instance once with `client.setConfig()` in `apps/admin-v2/src/lib/api.ts`.
