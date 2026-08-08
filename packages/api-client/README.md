# @scalius/api-client

Generated TypeScript SDK from the API worker's OpenAPI spec. It provides typed
API client methods and response types to this repository's admin dashboard and
storefront.

This is currently a private workspace package with TypeScript source exports.
It is not a published npm package or a supported third-party extension SDK.
An external management API, SDK, or CLI requires a separate compatibility and
release contract before it can be advertised.

## Current State

**The internal SDK is fully generated and operational.** The source of truth is
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

### Service Binding Mode

Worker-to-Worker requests can use a Cloudflare Service Binding. The caller must
provide authentication appropriate to the requested operation; this factory
does not exchange or mint credentials:

```typescript
import { createServiceBindingClient } from "@scalius/api-client/factory";

const client = createServiceBindingClient({
  serviceBinding: env.API,
  headers: request.headers,
});
```

### HTTP Mode

Standard fetch for local development and first-party clients:

```typescript
import { createHttpClient } from "@scalius/api-client/factory";

const client = createHttpClient({
  baseUrl: "http://localhost:8787",
});
```

## Regeneration

To regenerate the SDK after API changes:

```bash
pnpm generate:sdk
```

This imports the API app directly. If local dependency resolution prevents a
direct import, start the API worker with `pnpm dev:api` and rerun the command;
the generator then falls back to `http://localhost:8787`.

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

The admin and storefront consume the generated workspace contract:

- **Admin** (`apps/admin-v2/`) -- imports generated response types while its
  server proxy owns authenticated request forwarding
- **Storefront** (`apps/storefront/`) -- imports response types for its API client layer and L1/L2 cache typing
  and uses generated SDK methods through its configured fetch clients

## Dependencies

| Package | Purpose |
|---------|---------|
| `@hey-api/openapi-ts` (dev) | Code generation from OpenAPI spec |
| `tsx` (dev) | TypeScript execution for the spec generation script |

## Known Gaps

- Only routes using `@hono/zod-openapi`'s `createRoute()` appear in the generated spec. Any routes using plain Hono `.get()`/`.post()` are invisible to the SDK generator.
- Generated files are not hand-maintained. Regenerate with `pnpm generate:sdk` after changing an OpenAPI route schema or response contract.
- Generated operations do not yet have explicit stable `operationId` values.
  Path-derived method names are safe for current workspace consumers but are
  not an external compatibility contract.
- The package is private and source-only. Publishing requires a deliberate
  build/export map, package contents allow-list, provenance, and compatibility
  review; do not publish the workspace package as-is.
