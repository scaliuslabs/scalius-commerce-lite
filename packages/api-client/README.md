# @scalius/api-client

Generated TypeScript SDK from the API worker's OpenAPI spec. Provides typed API client methods and response types for consumers (admin dashboard and storefront).

## Current State

**The SDK is currently a hollow stub.** The generated types and SDK methods were deleted on 2026-03-15 during a cleanup, and regeneration has been deferred until the API surface stabilizes.

What exists today:

| File | Contents |
|------|----------|
| `src/generated/types.gen.ts` | 24 `any`-typed placeholder exports (e.g., `GetProductsResponse`, `PostOrdersResponse`) to prevent import errors in consumers |
| `src/generated/sdk.gen.ts` | Empty file (comment-only) |
| `src/generated/client.gen.ts` | Stub `client` object (`{} as Client`) and no-op `createClient()` |
| `src/generated/index.ts` | Barrel re-export of all generated files |
| `src/index.ts` | Root barrel re-export |

The previous OpenAPI spec (`openapi.json`) had 60 paths from an older version of the API. The live API now has 60+ route groups with 221+ endpoints. The spec is significantly out of date.

## Export Map

```json
{
  ".":        "./src/index.ts",
  "./types":  "./src/generated/types.gen.ts",
  "./sdk":    "./src/generated/sdk.gen.ts",
  "./client": "./src/generated/client.gen.ts"
}
```

```typescript
// Root: everything
import { client } from "@scalius/api-client";
import type { GetProductsResponse } from "@scalius/api-client";

// Types only
import type { GetProductsResponse, GetCategoriesResponse } from "@scalius/api-client/types";

// SDK methods (empty until regenerated)
import {} from "@scalius/api-client/sdk";

// Client instance
import { client } from "@scalius/api-client/client";
import type { CreateClientConfig } from "@scalius/api-client/client";
```

## Regeneration

Once the API surface is stable, regenerate with:

```bash
# 1. Start the API worker (it serves the OpenAPI spec)
pnpm dev --filter=@scalius/api

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
   - `src/generated/client.gen.ts` -- HTTP client using `@hey-api/client-fetch`

### Configuration

`openapi-ts.config.ts` uses three `@hey-api` plugins:

| Plugin | Purpose |
|--------|---------|
| `@hey-api/typescript` | Generate TypeScript types from OpenAPI schemas |
| `@hey-api/sdk` | Generate typed SDK methods from OpenAPI operations |
| `@hey-api/client-fetch` | Bundle the Fetch-based HTTP client |

## What It Will Provide (Once Regenerated)

- **Typed response types** for every API endpoint (e.g., `GetProductsResponse`, `PostOrdersResponse`) -- replaces the current `any` stubs
- **Typed SDK methods** that wrap `fetch()` calls with correct URL, method, body, and return types
- **A configured client** with base URL and auth header support

## Dependencies

| Package | Purpose |
|---------|---------|
| `@hey-api/openapi-ts` (dev) | Code generation from OpenAPI spec |
| `@hey-api/client-fetch` (dev) | Runtime HTTP client (bundled into generated output) |
| `tsx` (dev) | TypeScript execution for the spec generation script |

## Current Consumers

Despite the SDK being a stub, both admin and storefront import types from it:

- **Admin** (`apps/admin/`) -- imports response types for type annotations, currently resolves to `any`
- **Storefront** (`apps/storefront/`) -- imports response types (e.g., `GetProductsResponse`, `GetCollectionsResponse`) for its API client layer and L1/L2 cache typing, currently resolves to `any`

After regeneration, these imports will resolve to proper typed interfaces with zero code changes needed in consumers.

## Known Gaps

- The `openapi.json` file in the repo is stale (60 paths vs 221+ live endpoints). It will be overwritten on the next `pnpm generate:sdk` run.
- Only routes using `@hono/zod-openapi`'s `createRoute()` appear in the generated spec. Any routes using plain Hono `.get()`/`.post()` are invisible to the SDK generator.
- No runtime dependencies -- this is a dev-time code generation package. The generated client bundles `@hey-api/client-fetch` inline.
