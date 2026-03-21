# TypeScript & Type Safety Audit

## Executive Summary

The codebase demonstrates a strong **foundation** in TypeScript type safety. The shared `base.json` tsconfig enables `strict: true` and `noUncheckedIndexedAccess: true` globally, and both Astro apps extend `astro/tsconfigs/strict`. Zod is used extensively at API boundaries for runtime validation, and Drizzle ORM provides schema-derived types for the database layer. Domain types are well-organized into dedicated `.types.ts` files per module.

However, two systemic patterns account for the vast majority of type safety violations:

1. **`db.batch(... as any)`** -- Drizzle's D1 `batch()` method has an overly narrow tuple signature that doesn't accept dynamically-built statement arrays, forcing `as any` in ~25 call sites across `packages/core`.
2. **`app.openapi(route, (async (c: any) => { ... }) as any)`** -- Hono's `openapi()` handler type inference fails when response schemas use `.passthrough()` or complex union types, forcing both `c: any` parameter typing and `as any` on the handler return in ~42 route handlers across `apps/api`.

Together these two patterns account for roughly 67 of the 110 total `as any` casts. The remaining ~43 are scattered across UI components (library type mismatches), storefront middleware (Cloudflare-specific APIs), and SDK client envelope unwrapping.

**Overall type safety posture: Solid with known, contained escape hatches. No silent data corruption risks. The `any` usage is concentrated, documented, and fixable.**

---

## TSConfig Analysis (per package/app)

### Base Config (`packages/tsconfig/base.json`)

| Setting | Value | Assessment |
|---|---|---|
| `strict` | `true` | All strict checks enabled |
| `noUncheckedIndexedAccess` | `true` | Above-average strictness |
| `target` | `ES2022` | Appropriate for CF Workers |
| `module` | `ES2022` | Correct for ESM-only |
| `moduleResolution` | `bundler` | Correct for Vite/esbuild |
| `verbatimModuleSyntax` | `true` | Enforces explicit `type` imports |
| `isolatedModules` | `true` | Required for esbuild |
| `skipLibCheck` | `true` | Standard -- avoids third-party d.ts issues |
| `forceConsistentCasingInFileNames` | `true` | Good practice |

### Worker Config (`packages/tsconfig/worker.json`)
Extends base. Adds `@cloudflare/workers-types`. Used by `packages/core`, `packages/database`, `apps/api`.

### `packages/database/tsconfig.json`
Extends `worker.json`. Minimal -- only adds path aliases.

### `packages/core/tsconfig.json`
Extends `worker.json`. Adds path aliases to `@scalius/database/*` and `@scalius/shared/*`.

### `packages/shared/tsconfig.json`
Extends `base.json` (not worker). Adds `@cloudflare/workers-types` explicitly. No path aliases.

### `packages/api-client/tsconfig.json`
Extends `base.json`. Adds `DOM` lib for browser/fetch types. Has `outDir`/`rootDir` for compilation output.

### `apps/api/tsconfig.json`
Extends `worker.json`. Full path aliases to all three packages.

### `apps/admin/tsconfig.json`
Extends `astro/tsconfigs/strict`. Sets `jsx: react-jsx`, `jsxImportSource: react`, `verbatimModuleSyntax: true`. Full path aliases to packages.

### `apps/storefront/tsconfig.json`
Extends `astro/tsconfigs/strict`. Same React JSX config. Only `@/*` alias (no direct package aliases -- uses SDK).

**Assessment**: Consistent and strict across the board. No package uses a weaker config. The `noUncheckedIndexedAccess` in the base config is notably above-average for monorepo projects. All apps and packages inherit `strict: true`.

---

## Type Safety Violations Inventory

### Summary Counts

| Violation Type | Count | Files |
|---|---|---|
| `as any` casts | **110** | 58 files |
| Explicit `: any` annotations | **~25** | ~18 files |
| `@ts-ignore` | **4** | 4 files |
| `@ts-expect-error` | **0** | -- |
| `z.any()` (Zod) | **3** | 3 files |
| `Record<string, any>` | **~12** | ~8 files |
| `catch (e)` (untyped) | **5** | 4 files |
| Non-null assertions (`!.`) | **~9** | 5 files (packages only) |

### `as any` Breakdown by Category

| Category | Count | Root Cause |
|---|---|---|
| `db.batch(... as any)` | ~25 | Drizzle D1 batch() tuple type too narrow for dynamic arrays |
| `app.openapi(handler) as any` + `(c: any)` | ~42 | Hono OpenAPI handler inference fails on passthrough/union schemas |
| Storefront `(window as any)` | ~8 | Browser globals not in Window interface |
| Phone field / country libs | ~10 | `react-phone-number-input` type mismatches with country lists |
| SDK client `query/body as any` | ~5 | Generated SDK types don't match query param shapes |
| Cloudflare-specific APIs | ~6 | `caches.default`, `navigator.connection`, etc. |
| Drizzle self-reference | 2 | `(): any => table.id` for self-referential FK (Drizzle limitation) |
| Calendar/Badge component | 2 | Third-party component prop type mismatches |
| Miscellaneous | ~10 | One-off casts in diverse locations |

### `@ts-ignore` Locations

| File | Line | Reason |
|---|---|---|
| `apps/admin/src/pages/api/v1/[...path].ts` | 39 | Streaming request bodies |
| `apps/storefront/src/pages/api/customer-auth/[...path].ts` | 68 | Streaming request bodies (non-service-binding path) |
| `apps/storefront/src/components/header/DesktopNav.astro` | 244 | No comment explaining why |
| `apps/admin/src/components/ui/container-text-flip.tsx` | 36 | No comment explaining why |

### `z.any()` Locations

| File | Context |
|---|---|
| `apps/api/src/routes/media-server.ts:21` | Wildcard content type schema (appropriate) |
| `apps/api/src/routes/partytown-proxy.ts:71` | Wildcard content type schema (appropriate) |
| `packages/core/src/modules/orders/orders.validation.ts:66` | `bulkShipOrderSchema.options` -- should be typed |

### Notable Explicit `: any` Annotations

| File | Line | Context |
|---|---|---|
| `apps/storefront/src/lib/api/orders.ts` | 17 | `error?: any` in return type |
| `apps/storefront/src/lib/api/attributes.ts` | 41 | `let result: any` |
| `apps/storefront/src/lib/api/products.ts` | 128, 178, 218 | Index signature and `pagination: any` |
| `apps/storefront/src/lib/api/collections.ts` | 63 | `collection: any` in unwrap generic |
| `apps/admin/src/env.d.ts` | 31 | `[elemName: string]: any` in custom element declarations |
| `apps/storefront/src/lib/api/orders.ts` | 67, 70 | `Record<string, any>` in polling response parsing |

---

## Ratings

| Dimension | Score | Justification |
|---|---|---|
| **Maintainability** | **7/10** | Strong type organization per module (`.types.ts`, `.validation.ts`). Zod schemas colocated with domain logic. Enum constants pattern is clean. Deduction: some duplication between Zod entity schemas (`apps/api/src/schemas/entities.ts`) and TS interfaces (`packages/core/src/modules/*/types.ts`) -- same shapes defined twice in different forms. |
| **Robustness** | **7/10** | Runtime validation at all API boundaries via Zod. `strict: true` + `noUncheckedIndexedAccess` globally. Env types declared. Deduction: the 110 `as any` casts bypass compile-time checking at critical paths (batch writes, route handlers). `catch (e)` without `: unknown` in 5 places. |
| **Code Quality** | **7/10** | Good use of `z.infer<typeof schema>` to derive types from Zod. Drizzle `InferSelectModel` for DB types. Type inference relied upon where possible rather than explicit annotations. Generic utilities (`getCache<T>`, `registerProvider<T>`). Deduction: the pervasive `(c: any)` handler pattern means ~42 route handlers have completely untyped context. |
| **Scalability** | **8/10** | Provider system uses generics + Zod schema registration pattern -- adding new payment/email/delivery/SMS providers is strongly typed. Enum constants follow `as const` + type derivation pattern. Module augmentation used for Hono context (`ContextVariableMap`). API response envelope is standardized. |
| **Performance** | **9/10** | No complex conditional types or deep recursive generics that would impact IDE/build. Schema types are flat objects. Zod schemas are simple compositions. `skipLibCheck: true` prevents d.ts analysis overhead. Build uses esbuild (type-strip only, tsc for checking). |
| **Feature Readiness** | **8/10** | Well-structured for extension: validation schemas are composable (`.extend()`, `.partial()`), provider interfaces define clear contracts, entity schemas are centralized, enums use the const-object pattern for easy additions. Adding a new domain module has clear patterns to follow. |

**Weighted Overall: 7.5/10**

---

## Detailed Findings

### Strengths

**1. Strict mode everywhere, no exceptions.**
The `base.json` sets `strict: true` and `noUncheckedIndexedAccess: true`. Both Astro apps extend `astro/tsconfigs/strict`. No package or app weakens these settings. This is above-average for a real-world monorepo.

**2. Comprehensive Zod validation at API boundaries.**
Every domain module has a `.validation.ts` file with Zod schemas:
- `packages/core/src/modules/orders/orders.validation.ts`
- `packages/core/src/modules/products/products.validation.ts`
- `packages/core/src/modules/attributes/attributes.validation.ts`
- `packages/core/src/modules/widgets/widgets.validation.ts`
- `packages/core/src/modules/navigation/navigation.validation.ts`
- `packages/core/src/modules/categories/categories.validation.ts`
- `packages/core/src/modules/collections/collections.validation.ts`
- `packages/core/src/modules/discounts/discounts.validation.ts`
- `packages/core/src/modules/media/media.validation.ts`
- `packages/core/src/modules/pages/pages.validation.ts`
- `packages/core/src/modules/customers/customers.validation.ts`
- `packages/core/src/modules/inventory/inventory.validation.ts`
- `packages/core/src/modules/analytics/analytics.validation.ts`

Types are derived from schemas using `z.infer<typeof schema>`, ensuring runtime and compile-time types stay in sync.

**3. OpenAPI response schemas are strongly typed.**
`apps/api/src/schemas/entities.ts` defines Zod schemas for every API entity (products, orders, categories, customers, collections, discounts, pages, widgets, attributes, media, delivery, settings, navigation). These feed into the OpenAPI spec and SDK generation pipeline.

**4. Provider system is generically typed.**
The `ProviderMeta<TSettings>`, `ProviderFactory<TProvider, TSettings>`, and `ProviderRegistration<TProvider, TSettings>` generics in `packages/core/src/providers/types.ts` ensure type-safe provider registration and retrieval. Each provider category (payment, email, delivery, SMS) has its own strongly-typed interface extending `ProviderLifecycle`.

**5. Database types are Drizzle-inferred.**
All database types (`Product`, `Order`, `ProductVariant`, `Category`, etc.) use `InferSelectModel<typeof table>`, ensuring they stay in sync with the schema definition. No manual type-vs-schema drift.

**6. Enum pattern is robust.**
`packages/database/src/schema/enums.ts` uses `as const` objects with derived union types (`OrderStatus`, `PaymentMethod`, `FulfillmentStatus`, etc.). These are used both in schema defaults and in application logic, preventing string literal typos.

**7. API response envelope is standardized.**
`apps/api/src/schemas/responses.ts` provides `successEnvelope<T>()`, `paginatedEnvelope()`, `errorResponseSchema`, and shared response helpers. All routes use these consistently.

**8. Cloudflare env types are comprehensive.**
`apps/api/src/hono-env.d.ts` and `apps/api/src/env.d.ts` declare all Cloudflare bindings (D1, KV, R2, Queues, Secrets, Variables) with specific types. Hono's `ContextVariableMap` is augmented for type-safe `c.get("db")`, `c.get("user")`, `c.get("session")`.

### Weaknesses

**1. Hono OpenAPI handler typing is completely broken (42 handlers).**
Nearly every `app.openapi()` call in `apps/api/src/routes/` follows this anti-pattern:
```typescript
app.openapi(someRoute, (async (c: any) => {
  // handler body
}) as any);
```
This means:
- The `c` (context) parameter is untyped -- `c.req.valid("json")` is not type-checked
- The return type is not validated against the route's response schema
- TypeScript offers zero assistance inside these handlers

This appears to be a known Hono `@hono/zod-openapi` limitation when response schemas use `.passthrough()` or complex unions. The fix would be to either remove `.passthrough()` from entity schemas or use explicit type annotations on the handler parameter.

**2. Drizzle D1 `batch()` requires `as any` everywhere (25 sites).**
Every `db.batch()` call casts its argument:
```typescript
await db.batch(batchOps as any);
```
Drizzle's D1 adapter types `batch()` with a narrow tuple overload that doesn't accept `Array<SQLiteRawQueryResult>`. This is a framework limitation, but the cast means invalid statement arrays would not be caught.

**3. Storefront API types use `any` for response unwrapping.**
Files like `apps/storefront/src/lib/api/orders.ts`, `apps/storefront/src/lib/api/products.ts`, and `apps/storefront/src/lib/api/collections.ts` use `any` for pagination types and response data. The `unwrap.ts` helper centralizes one `as` cast but downstream consumers still use `any` for inner data shapes.

**4. `window` type augmentation is incomplete.**
Storefront code uses `(window as any).lastShippingEventDetail`, `(window as any).handleAbandonedCheckout`, `(window as any).__adminSidebarPageLoadBound__`, etc. These should be declared in `apps/storefront/src/env.d.ts` or `apps/admin/src/types/window.d.ts`.

**5. Two `@ts-ignore` directives lack justification.**
- `apps/storefront/src/components/header/DesktopNav.astro:244` -- no comment
- `apps/admin/src/components/ui/container-text-flip.tsx:36` -- no comment

The other two `@ts-ignore` directives are documented (streaming request bodies).

**6. `bulkShipOrderSchema.options` uses `z.any()`.**
In `packages/core/src/modules/orders/orders.validation.ts:66`, the `options` field accepts any shape. This should be replaced with a discriminated union of provider-specific option schemas.

**7. Duplicate type definitions between layers.**
The same entity shapes are defined in three places:
- Database layer: `InferSelectModel<typeof table>` in `packages/database/src/schema/*.ts`
- Core domain types: manual interfaces in `packages/core/src/modules/*/types.ts`
- API schemas: Zod objects in `apps/api/src/schemas/entities.ts`

These can drift. The product entity, for example, has slightly different field optionality across layers.

### Critical Issues

**None that would cause runtime failures.** The `as any` patterns are concentrated at framework boundaries (Drizzle batch, Hono OpenAPI) where the actual runtime behavior is correct -- the type system just can't express it. The Zod runtime validation at API boundaries catches malformed data regardless of the TypeScript-level gaps.

The most impactful issue is the **42 untyped route handlers** in `apps/api`. While Zod validates input at runtime, developers get zero IDE assistance when writing or modifying these handlers, increasing the risk of introducing bugs during maintenance.

---

## Recommendations

### Priority 1: Fix Hono OpenAPI Handler Typing (High Impact, Medium Effort)

The 42 `(c: any) => ... as any` handlers account for the single largest source of type unsafety. Two approaches:

**Option A**: Remove `.passthrough()` from all entity schemas in `apps/api/src/schemas/entities.ts`. This is the likely cause of the type inference failure. Test whether Hono's type inference works after removal.

**Option B**: Create a typed handler wrapper:
```typescript
type TypedHandler<R extends RouteConfig> = (c: Context<{ Bindings: Env }>) => Promise<TypedResponse<...>>;
```
This would restore type checking inside handlers even if the `openapi()` overload needs `as any` on the outside.

### Priority 2: Fix Drizzle batch() Typing (Medium Impact, Low Effort)

Create a typed wrapper around `db.batch()`:
```typescript
function typedBatch(db: Database, statements: SQLiteRunResult[]): Promise<...> {
  return db.batch(statements as any); // Single cast, documented
}
```
This centralizes the one `as any` into a single utility function, removing 25 scattered casts.

### Priority 3: Augment Window Interface (Low Impact, Low Effort)

Add missing properties to `apps/storefront/src/env.d.ts` and `apps/admin/src/types/window.d.ts`:
```typescript
interface Window {
  lastShippingEventDetail?: { fee: number; id: string };
  handleAbandonedCheckout?: () => void;
  __adminSidebarPageLoadBound__?: boolean;
  __USER_ID__?: string;
}
```

### Priority 4: Type the `bulkShipOrderSchema.options` Field

Replace `z.any().optional()` with a discriminated union keyed on provider type:
```typescript
options: z.union([
  z.object({ deliveryType: z.number(), itemType: z.number(), ... }), // Pathao
  z.object({ codAmount: z.number(), ... }), // Steadfast
]).optional()
```

### Priority 5: Unify Entity Type Definitions

Consider generating the API Zod schemas from the Drizzle schema using `drizzle-zod`, or at minimum add a test that asserts the shapes match. This would eliminate the risk of drift between the three layers (database, core types, API schemas).

### Priority 6: Add `@ts-expect-error` Comments

Replace the 2 undocumented `@ts-ignore` directives with `@ts-expect-error` plus a description of the expected error. This ensures the suppression is automatically removed when the underlying issue is fixed.
