# @scalius/api-client

Generated TypeScript SDK from the API worker's OpenAPI spec. Provides typed API client methods and response types for consumers (admin dashboard and storefront).

## Current State

**The SDK is fully generated and operational.** The source of truth is
`openapi.json` plus the generated files in `src/generated/**`; do not rely on
README prose for endpoint counts because the API surface changes often.

| File | Contents |
|------|----------|
| `openapi.json` | Checked-in OpenAPI artifact used by the generator |
| `src/generated/types.gen.ts` | Typed request/response interfaces for generated API endpoints |
| `src/generated/sdk.gen.ts` | Typed SDK methods generated from OpenAPI operations |
| `src/generated/client.gen.ts` | Generated default HTTP client |
| `src/generated/client/` | Bundled generated Fetch client used by the default client and factory |
| `src/generated/index.ts` | Barrel re-export of all generated files |
| `src/client-factory.ts` | Transport-agnostic client factory (Service Binding or HTTP) |
| `src/index.ts` | Root barrel re-export of generated types, SDK, client, and factory |

## Export Map

```json
{
  ".":        "./src/index.ts",
  "./types":  "./src/generated/types.gen.ts",
  "./sdk":    "./src/generated/sdk.gen.ts",
  "./client": "./src/generated/client.gen.ts",
  "./factory": "./src/client-factory.ts"
}
```

```typescript
// Root: everything
import { client } from "@scalius/api-client";
import type { GetApiV1AdminProductsResponse } from "@scalius/api-client";

// Types only
import type { GetApiV1AdminProductsResponse, PostApiV1AdminOrdersData } from "@scalius/api-client/types";

// SDK methods
import { getApiV1AdminProducts, postApiV1AdminOrders } from "@scalius/api-client/sdk";

// Client instance
import { client, createClient, createConfig } from "@scalius/api-client/client";
import type { Client, Config } from "@scalius/api-client/client";

// Client factory (Service Binding or HTTP)
import { createServiceBindingClient, createHttpClient } from "@scalius/api-client/factory";
```

## Client Factory

`src/client-factory.ts` provides transport-agnostic client creation:

### Service Binding Mode (Production)

Zero-latency RPC inside Cloudflare Workers. Used by admin (`env.API`) and storefront (`env.BACKEND_API`):

```typescript
import { createServiceBindingClient } from "@scalius/api-client/factory";

const client = createServiceBindingClient({
  serviceBinding: env.API,  // or env.BACKEND_API
  headers: { "X-API-Token": env.API_TOKEN },
});
```

### HTTP Mode (Development)

Standard fetch for dev mode or external consumers:

```typescript
import { createHttpClient } from "@scalius/api-client/factory";

const client = createHttpClient({
  baseUrl: "http://localhost:8787",
  headers: { Authorization: `Bearer ${token}` },
});
```

## Regeneration

To regenerate the SDK after API changes:

```bash
# 1. Start the API worker (it serves the OpenAPI spec)
pnpm --filter @scalius/api dev

# 2. Generate the spec and SDK
pnpm generate:sdk
# This runs: node --import tsx scripts/generate-spec.ts && openapi-ts
```

### What `generate:sdk` does

1. **`scripts/generate-spec.ts`** fetches the OpenAPI spec:
   - Strategy 1: Tries to import the Hono app directly and call `app.request("/api/v1/openapi.json")`
   - Strategy 2: Falls back to `fetch("http://localhost:8787/api/v1/openapi.json")` from a running dev server
   - Writes the result to `openapi.json` in the package root

2. **`openapi-ts`** (via `openapi-ts.config.ts`) reads `openapi.json` and generates:
   - `src/generated/types.gen.ts` -- TypeScript types for all request/response schemas
   - `src/generated/sdk.gen.ts` -- Typed SDK methods (one per endpoint)
   - `src/generated/client.gen.ts` and `src/generated/client/**` -- default client plus bundled Fetch client

### Configuration

`openapi-ts.config.ts` uses three `@hey-api` plugins:

| Plugin | Purpose |
|--------|---------|
| `@hey-api/typescript` | Generate TypeScript types from OpenAPI schemas |
| `@hey-api/sdk` | Generate typed SDK methods from OpenAPI operations |
| `@hey-api/client-fetch` | Generate the bundled Fetch-based HTTP client |

## Consumers

Both admin and storefront import types and SDK methods:

- **Admin** (`apps/admin-v2/`) -- imports response types for type annotations and SDK methods for API calls via service binding
- **Storefront** (`apps/storefront/`) -- imports response types for its API client layer and L1/L2 cache typing

## Dependencies

| Package | Purpose |
|---------|---------|
| `@hey-api/openapi-ts` (dev) | Code generation from OpenAPI spec |
| `tsx` (dev) | TypeScript execution for the spec generation script |

## Known Gaps

- Only routes using `@hono/zod-openapi`'s `createRoute()` appear in the generated spec. Any routes using plain Hono `.get()`/`.post()` are invisible to the SDK generator.
- Generated files are not hand-maintained. Regenerate with `pnpm generate:sdk` after changing an OpenAPI route schema or response contract.
