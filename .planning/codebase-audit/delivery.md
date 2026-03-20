# Delivery Domain Audit

**Date:** 2026-03-20
**Scope:** Complete vertical slice -- schema, core services, API routes, webhooks, webhook auth, credential encryption, admin UI components.

## Summary

The delivery domain is the most architecturally complete vertical slice in the codebase. It features a well-designed provider factory pattern, AES-GCM credential encryption, KV-based webhook replay protection, insert-first shipment creation, comprehensive status mapping for two providers (Pathao, Steadfast), and a full admin UI with provider management, location hierarchy, and shipment tracking. The domain has a thorough README (`packages/core/src/modules/delivery/README.md`) that accurately documents current state.

However, the audit reveals several concrete issues: a dual provider interface problem (two competing type systems), inconsistent timestamp generation across files, unused schema columns, missing test coverage (zero test files), a placeholder notification function masquerading as real code, and type-safety erosion via `as any` casts in API routes.

---

## Critical Issues

### 1. Dual Provider Interface -- Two Competing Type Systems

**Files:**
- `packages/core/src/modules/delivery/provider.ts` -- `DeliveryProviderInterface` (active, used by Pathao/Steadfast)
- `packages/core/src/providers/delivery/types.ts` -- `DeliveryProvider` (new universal system, zero implementations)

The legacy interface in `provider.ts` takes a raw `Order` object and provider-specific `ShipmentOptions`:
```typescript
createShipment(order: Order, options?: ShipmentOptions): Promise<ShipmentResult>;
checkShipmentStatus(externalId: string): Promise<ShipmentStatus>;
```

The new universal interface in `providers/delivery/types.ts` takes a normalized `ShipmentData` object:
```typescript
createShipment(data: ShipmentData): Promise<ShipmentResult>;
trackShipment(externalId: string): Promise<TrackingStatus>;
```

Both extend `ProviderLifecycle` but define incompatible method signatures and return types. The `ShipmentResult` type is even defined differently in each:
- Legacy (`types.ts`): `{ success: boolean; message: string; data?: { externalId?, trackingId?, ... } }`
- New (`providers/delivery/types.ts`): `{ externalId: string; trackingId?: string; status: ShipmentStatusCode; ... }`

The new system also defines `ShipmentStatusCode` as a union type with 8 values, while the legacy `status-mapper.ts` defines it as an enum with 14 values.

**Impact:** Any future provider implementation will have to choose one system. New developers will be confused about which to implement. The CLAUDE.md "Known Backlog" acknowledges this: "delivery and SMS have type definitions with zero registered implementations in the new system."

**Fix approach:** Migrate `PathaoProvider` and `SteadfastProvider` to implement the new `DeliveryProvider` interface. Adapt the factory to produce `DeliveryProvider` instances. Reconcile the two `ShipmentResult` and `ShipmentStatusCode` definitions. Delete `packages/core/src/modules/delivery/provider.ts` once migration is complete.

### 2. Inconsistent Timestamp Generation -- `CURRENT_TIMESTAMP` vs `unixepoch()`

**Files:**
- `packages/core/src/modules/delivery/locations.ts` (lines 108-109, 118, 147-148) -- uses `sql\`CURRENT_TIMESTAMP\``
- `packages/core/src/modules/delivery/pathao-location-import.ts` (line 233) -- uses `sql\`CURRENT_TIMESTAMP\``
- `packages/core/src/modules/delivery/delivery.service.ts` (lines 90, 102-103, 209-210, 234, 248, 263, 349) -- uses `sql\`unixepoch()\``
- `packages/core/src/modules/delivery/tracking.ts` (line 107) -- uses `new Date()` directly
- Webhook routes (`apps/api/src/routes/webhooks/pathao.ts` line 135, `steadfast.ts` line 155) -- use `new Date()` directly

The schema defines timestamps as `integer("...", { mode: "timestamp" })` with default `UNIX_NOW` (which is `sql\`(unixepoch())\``). This means the column stores Unix epoch seconds as integers.

`CURRENT_TIMESTAMP` returns an ISO 8601 string (`"2026-03-20 12:00:00"`), not an integer. When stored in an integer column, SQLite will silently coerce it -- likely to `0` or the first numeric characters. This means **all location timestamps written by `locations.ts` and `pathao-location-import.ts` are corrupted**.

`new Date()` in `tracking.ts` line 107 passes a JavaScript Date object to Drizzle. Drizzle's `{ mode: "timestamp" }` will convert it to Unix seconds, so this works correctly. But it is inconsistent with the `sql\`unixepoch()\`` approach used elsewhere.

**Impact:** Location `createdAt`, `updatedAt`, and `deletedAt` values are wrong in the database. Any query that sorts or filters locations by timestamp will produce incorrect results.

**Fix approach:** Replace all `sql\`CURRENT_TIMESTAMP\`` with `sql\`(unixepoch())\`` in `locations.ts` and `pathao-location-import.ts`. Standardize on either `new Date()` (let Drizzle convert) or `sql\`(unixepoch())\`` across all files. The existing codebase convention (per CLAUDE.md) is `UNIX_NOW` / `sql\`(unixepoch())\``.

### 3. Webhook Auth Falls Through to "Allow All" When No Secret Configured

**File:** `apps/api/src/middleware/webhook-auth.ts` (lines 221-228)

When a delivery provider has no `webhookSecret` and no `allowedWebhookIps` configured, the webhook auth middleware logs a warning but **allows the request through**:

```typescript
// --- Strategy 3: No security configured (backward compatible) ---
console.warn(`[webhook-auth] [${providerType}] SECURITY WARNING: ...`);
return { verified: true, credentials, config };
```

This means any unauthenticated POST to `/api/v1/webhooks/pathao` or `/api/v1/webhooks/steadfast` will be processed if the provider doesn't have webhook credentials configured.

**Impact:** An attacker can forge webhook payloads to change shipment statuses and trigger order status changes (including marking orders as "delivered" or "returned"), which in turn triggers inventory adjustments via `applyInventoryForStatusChange()`.

**Fix approach:** Change Strategy 3 to `verified: false` by default. Add a configuration flag `allowUnsecuredWebhooks: true` in provider config for merchants who explicitly opt in during initial setup. At minimum, add rate limiting to the webhook endpoints.

---

## Code Quality Issues

### 4. `as any` Type Casts in API Routes

**Files:**
- `apps/api/src/routes/admin/shipments.ts` line 111: `(async (c: any) => {` and line 167: `}) as any);`
- `apps/api/src/routes/admin/settings/delivery-providers.ts` lines 116, 149, 176, 234: `(async (c: any) => {` with `}) as any);`
- `apps/api/src/routes/admin/orders.ts` line 197: `(async (c: any) => {` with `}) as any);`

These casts bypass Hono's typed context, losing type safety for `c.get("db")`, `c.req.valid("json")`, `c.req.valid("param")`, and `c.env`. This is the pattern described in CLAUDE.md as "~14 `any` type usages remain."

**Impact:** Type errors in route handlers will not be caught at build time.

**Fix approach:** The casts exist because OpenAPIHono's `openapi()` method has strict type inference that sometimes conflicts with custom context types (like `db` set by middleware). The proper fix is to define a shared `HonoApp` type that includes both `Env` bindings and middleware-injected variables, then type the route handlers against it.

### 5. Unused Schema Columns

**File:** `packages/database/src/schema/delivery.ts`

Five columns on `deliveryShipments` are defined but never written to:
- `trackingUrl` (line 56) -- tracking URLs are computed on the fly by `getTrackingUrl()` in `tracking.ts`
- `courierName` (line 57) -- never set during provider-based shipment creation
- `shipmentItems` (line 63) -- always null
- `shipmentAmount` (line 64) -- always null
- `isFinalShipment` (line 65) -- defaults to `false`, never set to `true`

**Impact:** Dead columns increase confusion for new developers and waste storage. The `courierName` gap means the admin UI falls back to provider name lookup (which fails if the provider is deleted since `providerId` is SET NULL on cascade).

**Fix approach:** Either populate these columns during shipment creation (easy wins: set `courierName` from provider name, set `trackingUrl` from `getTrackingUrl()`, populate `shipmentAmount` from options.codAmount) or drop them in a migration if they'll never be used.

### 6. Pathao Token Caching -- Dual Implementation

**Files:**
- `packages/core/src/modules/delivery/providers/pathao.ts` lines 25-26: instance-level `accessToken` and `tokenExpiry` with 1-hour safety margin
- `packages/core/src/modules/delivery/pathao-location-import.ts` line 60: module-level `cachedToken` with 10-minute safety margin

Two independent token caching mechanisms exist. The provider class caches per-instance (lost between requests in Workers), while the import module caches in a module-level variable (persists within the same Worker isolate).

**Impact:** Every provider API call from the service layer acquires a fresh token (since the `PathaoProvider` instance is created fresh by `createProvider()` on each request). Only the location import benefits from caching.

**Fix approach:** Move token caching to KV (with encryption) or accept the per-request token acquisition cost. If keeping in-memory, document that it only helps within a single request's provider instance lifetime.

### 7. `SteadfastProvider.testConnection()` Mutates Credentials

**File:** `packages/core/src/modules/delivery/providers/steadfast.ts` lines 53-61

```typescript
this.credentials = {
    ...this.credentials,
    apiKey: trimmedApiKey,
    secretKey: trimmedSecretKey,
    baseUrl: this.credentials.baseUrl.trim(),
};
```

The `testConnection()` method modifies `this.credentials` as a side effect. If `testConnection()` is called before `createShipment()`, the credentials are trimmed. If not, they may contain whitespace. This is fragile -- the trimming should happen in the constructor or in `getHeaders()`.

**Impact:** Credentials may or may not be trimmed depending on call order.

**Fix approach:** Trim credentials once in the constructor. Remove the mutation from `testConnection()`.

### 8. `testConnection()` Double-Consumes Response Body

**File:** `packages/core/src/modules/delivery/providers/steadfast.ts` lines 71-77

```typescript
try {
    await response.text(); // consume body once
} catch (readError: unknown) {
    // Ignore
}

if (response.status === 200 || response.status === 404) {
    return { success: true, message: "Connection successful" };
} else {
    try {
        const data = await response.json() as Record<string, unknown>; // ERROR: body already consumed
```

The response body is consumed by `response.text()`, then `response.json()` is called on the same response in the error branch. This will throw because the body stream is already consumed. The error handling for non-200/404 responses is effectively broken.

**Impact:** When a Steadfast test connection returns an error status (e.g., 401, 500), the actual error message is lost. The user sees a generic "Connection failed with status: NNN" instead.

**Fix approach:** Read `response.text()` once, then use `JSON.parse()` on the text if needed for error details.

---

## Pattern Violations

### 9. Error Handling Inconsistency: Return vs Throw

**File:** `packages/core/src/modules/delivery/delivery.service.ts`

The `createShipment()` function (lines 147-272) returns `{ success: false, message: "..." }` for order-not-found and provider-not-found cases, while `checkShipmentStatus()` (lines 314-371) and `testDeliveryProvider()` (lines 122-137) throw `NotFoundError`. The `deleteShipmentRecord()` silently succeeds even if the record doesn't exist.

The rest of the codebase uses the throw pattern (per CLAUDE.md: "Use `ApiError` classes from `apps/api/src/utils/api-error.ts`").

**Impact:** Callers of `createShipment()` must check `result.success` instead of catching exceptions, which is inconsistent with the rest of the API layer.

**Fix approach:** Throw `NotFoundError` from `createShipment()` instead of returning success:false. Update the API route handler accordingly (it currently expects the return-value pattern).

### 10. Location Search Uses LIKE Instead of FTS5

**File:** `packages/core/src/modules/delivery/locations.ts` line 79

```typescript
like(deliveryLocations.name, `%${query}%`)
```

CLAUDE.md states: "FTS5: All text search uses SQLite FTS5. Helpers in `packages/core/src/search/fts5.ts`." The location search uses `LIKE '%query%'` instead.

**Impact:** Location search won't benefit from FTS5 indexing, and for large location sets (Bangladesh has ~1500+ areas), this could be slow. Also violates the codebase convention.

**Fix approach:** Add a FTS5 virtual table for delivery locations (or use the existing FTS5 helper). For the limited dataset size, this is low priority but violates the established pattern.

### 11. `saveDeliveryProvider()` Does SELECT-then-INSERT/UPDATE (Non-Atomic)

**File:** `packages/core/src/modules/delivery/delivery.service.ts` lines 47-108

```typescript
const existingProvider = await getDeliveryProvider(db, providerId);
if (existingProvider) {
    await db.update(deliveryProviders).set({...}).where(...);
} else {
    await db.insert(deliveryProviders).values({...});
}
```

This is a TOCTOU (time-of-check, time-of-use) race. Two concurrent requests to create the same provider could both see "not exists" and both attempt to INSERT, causing one to fail on the primary key constraint.

**Impact:** Low probability in single-admin scenarios, but the pattern violates the codebase's own hardening principles (see inventory domain's CAS approach).

**Fix approach:** Use `INSERT ... ON CONFLICT DO UPDATE` (Drizzle's `onConflictDoUpdate()`).

---

## Maintainability Concerns

### 12. DeliveryShipmentManager Uses `window.shipmentActions` Bridge

**File:** `apps/admin/src/components/admin/DeliveryShipmentManager.tsx` lines 20-29

```typescript
declare global {
    interface Window {
        shipmentActions: {
            createShipment: (...) => Promise<any>;
            checkShipmentStatus: (...) => Promise<any>;
            deleteShipment: (...) => Promise<boolean>;
        };
    }
}
```

This component expects a global `window.shipmentActions` object to be injected by the Astro page script. But the `Grep` for `window.shipmentActions` across `apps/admin/src/pages/` found zero matches -- the bridge is never set up.

Meanwhile, `ShipmentForm.tsx` and `ShipmentList.tsx` make direct `fetch()` calls to the API. This means `DeliveryShipmentManager.tsx` is likely broken or not currently used.

**Impact:** Dead or broken component. If it IS used, the `window.shipmentActions` bridge is fragile and untestable compared to the direct-fetch approach used by the other shipment components.

**Fix approach:** Either wire up the `window.shipmentActions` bridge in the Astro page that renders this component, or migrate to the direct-fetch pattern used by `ShipmentForm.tsx` and `ShipmentList.tsx`. Check whether this component is actually rendered anywhere.

### 13. Duplicate Status Display Logic

**Files:**
- `apps/admin/src/components/admin/ShipmentStatusBadge.tsx` -- switch on uppercase status, returns styled badge
- `apps/admin/src/components/admin/ShipmentStatusIndicator.tsx` -- `getStatusColor()` switch on lowercase status, plus `formatStatus()`, plus `getRelativeTime()`
- `apps/admin/src/components/admin/ShipmentList.tsx` -- inline `getRelativeTime()` (identical logic, lines 186-207)
- `apps/admin/src/components/admin/DeliveryShipmentManager.tsx` -- uses `ShipmentStatusIndicator`

`getRelativeTime()` is duplicated verbatim in `ShipmentStatusIndicator.tsx` (lines 24-45) and `ShipmentList.tsx` (lines 186-207). `ShipmentStatusBadge` and `ShipmentStatusIndicator` both map statuses to display representations with different color schemes.

**Impact:** Maintenance burden. A new status code requires updates in multiple places.

**Fix approach:** Extract `getRelativeTime()` to `@scalius/shared/utils`. Consolidate status-to-color mapping into `ShipmentStatusBadge` and have `ShipmentStatusIndicator` use it.

### 14. `notifyShipmentStatusChange()` is a Placeholder

**File:** `packages/core/src/modules/delivery/tracking.ts` lines 139-188

```typescript
// This is a placeholder for future notification implementation
console.log(`Status change notification for shipment ${shipmentId}...`);
```

This function is called from both webhook handlers and the manual status check route, giving the impression that notifications are sent. In reality, it only logs to the console and returns a notification info object that nobody uses.

**Impact:** Misleading -- callers and future developers may assume notifications are working. The README even acknowledges this as a known gap.

**Fix approach:** Either implement real notifications (integrate with the existing `ORDER_NOTIFICATIONS_QUEUE`) or rename the function to `logShipmentStatusChange()` and remove the return value.

---

## Performance & Scalability

### 15. Location Import -- Individual DB Writes Instead of Batch

**File:** `packages/core/src/modules/delivery/pathao-location-import.ts` lines 222-249

Despite the function being named `bulkUpsert`, updates and inserts are executed individually in loops:

```typescript
for (const u of updates) {
    await db.update(deliveryLocations).set({...}).where(...);
}
for (const ins of inserts) {
    await db.insert(deliveryLocations).values({...});
}
```

For area imports (thousands of records), this means thousands of individual SQL statements.

**Impact:** The import already takes 60-90 seconds. D1 has per-request limits on subrequests. Individual writes are slower than batched writes and more likely to hit Worker CPU time limits.

**Fix approach:** Use `db.batch()` to batch multiple statements in a single D1 call. Drizzle supports this with `db.batch([...])`. Batch inserts in groups of 50-100.

### 16. `getExternalLocationIds()` Makes 3 Sequential DB Queries

**File:** `packages/core/src/modules/delivery/locations.ts` lines 243-275

```typescript
if (locations.city) result.city = await getExternalLocationId(db, locations.city, providerType);
if (locations.zone) result.zone = await getExternalLocationId(db, locations.zone, providerType);
if (locations.area) result.area = await getExternalLocationId(db, locations.area, providerType);
```

Each call to `getExternalLocationId()` makes a separate DB query. For Pathao shipment creation, this is 3 sequential round-trips.

**Impact:** Adds ~15-30ms latency per shipment creation (3 D1 queries). For bulk shipping, this compounds.

**Fix approach:** Use a single query with `IN` clause: `WHERE id IN (city, zone, area)`. Parse results into a map.

### 17. Webhook Handlers Do Not Use `db.batch()`

**Files:**
- `apps/api/src/routes/webhooks/pathao.ts` lines 130-157
- `apps/api/src/routes/webhooks/steadfast.ts` lines 155-180

Each webhook processes: DB read (find shipment) -> DB write (update shipment) -> optional DB writes (update order, record webhook event) -> KV write. These are all sequential.

**Impact:** Webhook processing latency is higher than necessary. Pathao and Steadfast may retry if the response is slow.

**Fix approach:** Batch the shipment update, order status update, and webhook event recording into a single `db.batch()` call.

---

## Robustness Gaps

### 18. Webhook Idempotency Key Doesn't Include Timestamp

**Files:**
- `apps/api/src/routes/webhooks/pathao.ts` line 87: `const eventId = \`${consignmentId}_${event}\``
- `apps/api/src/routes/webhooks/steadfast.ts` line 50: `const kvKey = \`delivery_wh:steadfast:${consignmentIdRaw}_${notificationType || "unknown"}\``

The idempotency key is `consignment_id + event_type`. If a shipment transitions to status A, then back to status B (e.g., failed delivery then re-attempted), and the same event fires again (e.g., `order.delivered` on retry), the second event will be deduplicated and ignored because the KV key still exists from the first `order.delivered` (within 24h TTL).

**Impact:** Legitimate re-delivery after failure may not update the shipment status if the same event type fires within 24 hours.

**Fix approach:** Include a timestamp or sequence number in the idempotency key. Alternatively, use the webhook payload's `updated_at` field: `${consignmentId}_${event}_${updatedAt}`.

### 19. `checkShipmentStatus()` Doesn't Validate `externalId` Existence

**File:** `packages/core/src/modules/delivery/delivery.service.ts` line 340

```typescript
const statusResult = await providerInstance.checkShipmentStatus(
    shipment.externalId as string,
);
```

The `as string` cast bypasses the fact that `externalId` can be `null` (the column is nullable). If a shipment was created but the provider call failed (status "failed", rawStatus "exception"), `externalId` will be null.

**Impact:** Calling `checkShipmentStatus()` on a failed shipment will pass `null` (as `"null"` string) to the provider API, causing an API error or garbage response.

**Fix approach:** Add a null check before calling the provider: `if (!shipment.externalId) throw new ValidationError("Shipment has no external ID (creation may have failed)")`.

### 20. Provider Deletion Doesn't Check for Active Shipments

**File:** `apps/api/src/routes/admin/settings/delivery-providers.ts` lines 385-394

```typescript
app.openapi(deleteProviderRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await db.delete(deliveryProviders).where(eq(deliveryProviders.id, id));
    return ok(c, {});
});
```

The schema has `onDelete: "set null"` for shipment.providerId, so deletion won't fail. But existing shipments will lose their provider reference, making it impossible to check their status.

**Impact:** After provider deletion, the admin can't use "Check Status" on existing shipments (the code will throw `NotFoundError` for the null `providerId`).

**Fix approach:** Before deletion, check if any non-terminal shipments exist for this provider. Warn the admin or prevent deletion if active shipments exist.

### 21. Location `DELETE /all` is a Hard Delete Without Confirmation

**File:** `apps/api/src/routes/admin/settings/delivery-locations.ts` lines 160-169

```typescript
app.openapi(deleteAllRoute, async (c) => {
    const db = c.get("db");
    await db.delete(deliveryLocations);
    return ok(c, { message: "All delivery locations have been permanently deleted." });
});
```

This permanently deletes ALL delivery locations from the database with no confirmation, no soft-delete, and no way to recover. The admin UI does show a confirmation dialog, but the API endpoint has no safeguard.

**Impact:** Accidental deletion of all location data (including Pathao mappings) requires a full re-import.

**Fix approach:** Add a required confirmation token (e.g., `{ confirm: "DELETE_ALL_LOCATIONS" }`) in the request body.

---

## LLM-Friendliness

### Strengths

1. **Excellent README**: `packages/core/src/modules/delivery/README.md` is the best domain README in the codebase -- comprehensive, accurate, includes known gaps, and has a step-by-step "Adding a New Provider" guide.

2. **Clear factory pattern**: `factory.ts` has a simple switch-case that's easy for an LLM to extend.

3. **Status mapper is exhaustive**: Both Pathao and Steadfast status maps include comments explaining the format differences (webhook vs API) and normalization rules.

4. **Insert-first pattern is well-documented**: The shipment creation flow has clear numbered comments (steps 1-5) explaining the strategy and why.

5. **Provider interface is well-documented**: JSDoc comments on `DeliveryProviderInterface` clearly explain each method's purpose and parameters.

### Weaknesses

1. **Two competing type systems** (Issue #1) will confuse any LLM tasked with adding a new provider.

2. **`window.shipmentActions` bridge** (Issue #12) has no documentation about how/where it should be set up.

3. **The `notifyShipmentStatusChange()` placeholder** looks like real code -- an LLM will assume notifications work.

4. **Credential masking logic** in `delivery-providers.ts` is spread across two functions (`maskCredentialsForClient` and `unmaskedCredentials`) that are easy to get wrong.

5. **Timestamp inconsistency** means an LLM copying patterns from `locations.ts` will propagate the `CURRENT_TIMESTAMP` bug to new code.

---

## Recommended Changes

### Priority 1 (Critical)

| # | Issue | Files | Effort |
|---|-------|-------|--------|
| 2 | Fix `CURRENT_TIMESTAMP` -> `(unixepoch())` in locations.ts and pathao-location-import.ts | `packages/core/src/modules/delivery/locations.ts`, `pathao-location-import.ts` | 15 min |
| 3 | Change webhook auth Strategy 3 to reject by default | `apps/api/src/middleware/webhook-auth.ts` | 30 min |
| 19 | Add null check for `externalId` before status check | `packages/core/src/modules/delivery/delivery.service.ts` | 5 min |

### Priority 2 (Important)

| # | Issue | Files | Effort |
|---|-------|-------|--------|
| 1 | Plan migration from dual provider interface to unified | `provider.ts`, `providers/delivery/types.ts`, both provider classes, `factory.ts` | 4-6 hours |
| 5 | Populate unused columns or plan migration to drop them | `delivery.service.ts`, schema | 1 hour |
| 7 | Trim credentials in SteadfastProvider constructor | `providers/steadfast.ts` | 10 min |
| 8 | Fix double-consumed response body in testConnection | `providers/steadfast.ts` | 15 min |
| 9 | Standardize error handling (throw not return) in createShipment | `delivery.service.ts`, shipment API routes | 30 min |
| 12 | Determine if DeliveryShipmentManager is used; fix or remove | `DeliveryShipmentManager.tsx`, page scripts | 1 hour |
| 18 | Include timestamp in webhook idempotency key | `pathao.ts`, `steadfast.ts` webhooks | 15 min |
| 20 | Check for active shipments before provider deletion | `delivery-providers.ts` API route | 30 min |

### Priority 3 (Improvements)

| # | Issue | Files | Effort |
|---|-------|-------|--------|
| 4 | Remove `as any` casts from route handlers | `shipments.ts`, `delivery-providers.ts`, `orders.ts` | 2 hours |
| 6 | Unify token caching for Pathao | `providers/pathao.ts`, `pathao-location-import.ts` | 1 hour |
| 13 | Extract duplicate `getRelativeTime()` to shared utils | `ShipmentStatusIndicator.tsx`, `ShipmentList.tsx` | 30 min |
| 14 | Integrate notification with queue or rename placeholder | `tracking.ts` | 1-2 hours |
| 15 | Batch location import DB writes | `pathao-location-import.ts` | 1 hour |
| 16 | Single query for external location IDs | `locations.ts` | 30 min |
| 17 | Batch webhook DB operations | `pathao.ts`, `steadfast.ts` webhooks | 1 hour |
| 21 | Add confirmation token for DELETE /all | `delivery-locations.ts` API route | 15 min |

### Zero Test Coverage

There are no test files for the delivery domain. Given the complexity (webhook processing, status mapping, credential encryption, insert-first shipment creation, inventory side-effects), the following should be prioritized:

1. **Status mapper tests** -- verify all Pathao and Steadfast status strings map correctly
2. **Webhook handler tests** -- verify idempotency, status updates, order status sync
3. **Insert-first pattern tests** -- verify DB state after provider success, failure, and exception
4. **Credential encryption round-trip tests** -- encrypt then decrypt, graceful fallback for plaintext
5. **Webhook auth tests** -- verify HMAC, Bearer token, IP allowlist, and no-config fallback behavior
