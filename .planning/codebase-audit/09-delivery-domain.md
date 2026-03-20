# 09 - Delivery Domain Audit

**Date:** 2026-03-20
**Scope:** Delivery module — provider abstraction, shipment lifecycle, webhook handling, location management, status mapping, credential security, error handling, admin UI

**Files Reviewed:**

- `packages/core/src/modules/delivery/delivery.service.ts`
- `packages/core/src/modules/delivery/factory.ts`
- `packages/core/src/modules/delivery/provider.ts`
- `packages/core/src/modules/delivery/types.ts`
- `packages/core/src/modules/delivery/locations.ts`
- `packages/core/src/modules/delivery/tracking.ts`
- `packages/core/src/modules/delivery/status-mapper.ts`
- `packages/core/src/modules/delivery/pathao-location-import.ts`
- `packages/core/src/modules/delivery/providers/pathao.ts`
- `packages/core/src/modules/delivery/providers/steadfast.ts`
- `packages/core/src/modules/delivery/index.ts`
- `packages/database/src/schema/delivery.ts`
- `apps/api/src/routes/admin/shipments.ts`
- `apps/api/src/routes/admin/settings/delivery-providers.ts`
- `apps/api/src/routes/admin/settings/delivery-locations.ts`
- `apps/api/src/routes/admin/settings/shipping.ts`
- `apps/api/src/routes/webhooks/pathao.ts`
- `apps/api/src/routes/webhooks/steadfast.ts`
- `apps/api/src/middleware/webhook-auth.ts`
- `packages/core/src/utils/credential-encryption.ts`
- `apps/admin/src/components/admin/delivery-providers/*` (all files)
- `apps/admin/src/components/admin/delivery-locations/*` (all files)
- `apps/admin/src/components/admin/DeliveryShipmentManager.tsx`

---

## 1. Architecture Overview

The delivery domain follows a **Strategy pattern** with a clean provider abstraction:

```
DeliveryProviderInterface (provider.ts)
    |
    +-- PathaoProvider (providers/pathao.ts)
    +-- SteadfastProvider (providers/steadfast.ts)
    |
factory.ts  -- createProvider() dispatches by type
    |
delivery.service.ts  -- orchestrates CRUD + insert-first shipment creation
tracking.ts          -- shipment-to-order status propagation
status-mapper.ts     -- external status normalization
locations.ts         -- city/zone/area hierarchy management
pathao-location-import.ts -- chunked bulk import from Pathao API
```

**Data flow:** Admin UI -> API route -> delivery.service -> factory -> provider -> external API -> webhook -> status-mapper -> tracking -> order update.

The pattern is well-designed for adding new providers. A new implementation requires: (1) a provider class implementing `DeliveryProviderInterface`, (2) a case in `factory.ts`, (3) a status map in `status-mapper.ts`, (4) a webhook route, and (5) type definitions.

---

## 2. Provider Interface

### Strengths

- **Consistent abstraction:** `DeliveryProviderInterface` extends `ProviderLifecycle` (shared with payment, email, SMS providers), giving a uniform `initialize/healthCheck/dispose` contract alongside delivery-specific `createShipment/checkShipmentStatus/testConnection`.
- **Clear type contracts:** `ShipmentResult` and `ShipmentStatus` are well-defined return types with mandatory fields plus optional metadata.
- **Status normalization:** Both providers use `mapProviderStatus()` consistently, never leaking raw provider statuses into the database `status` column.
- **LLM-friendly:** The provider pattern is discoverable. `DeliveryProviderInterface` in `provider.ts` is the single source of truth for what a provider must implement. A developer (or LLM) can copy `steadfast.ts` as a template.

### Issues

**P1 - Module-level singleton `db` import in PathaoProvider (BUG)**

`providers/pathao.ts` line 14:
```typescript
import { db } from "@scalius/database/client";
```

This imports the module-level singleton database reference. In Cloudflare Workers, the `db` singleton is initialized per-isolate but the `getDb(env)` pattern is the correct approach (as used in webhooks and routes). The `PathaoProvider.createShipment()` method calls `getExternalLocationIds(db, ...)` on line 183 using this singleton rather than a database instance from the request context.

**Impact:** In Cloudflare Workers, `db` may not be properly initialized when the module is loaded. This works in practice only because the singleton happens to point to the same D1 binding, but it violates the project's DI pattern and will break if multi-tenant isolation is ever needed. It also makes the provider untestable in isolation.

**Fix:** Pass `db` into `createProvider()` or into the provider constructor, and thread it through to `getExternalLocationIds()`.

**P2 - Steadfast ignores `_config` parameter**

`providers/steadfast.ts` line 21:
```typescript
constructor(credentials: SteadfastCredentials, _config: SteadfastConfig) {
    this.credentials = credentials;
}
```

The `SteadfastConfig.defaultCodAmount` is defined but never used. The COD amount comes from `options?.codAmount` or is calculated from the order. The `defaultCodAmount` config field in the admin UI is misleading -- saving it has no effect.

**Impact:** Low, but confusing for merchants who set it expecting it to be used as a fallback.

**P3 - `saveDeliveryProvider` encrypts on save but `createProvider` in `factory.ts` doesn't always decrypt**

`delivery.service.ts` line 74 encrypts credentials when `encryptionKey` is provided. `factory.ts` line 28 always calls `decryptCredentialsGraceful`. However, `delivery.service.ts:createShipment()` calls `createProvider(provider)` on line 216 **without passing an encryption key**, so the factory receives the raw DB row (encrypted) but has no key to decrypt it.

This works only because `decryptCredentialsGraceful` falls back to returning the value as-is when no key is provided AND when the provider was saved without encryption. If encryption is enabled, `createShipment` will pass encrypted credentials to the provider constructors, which will fail to authenticate.

**Impact:** Shipment creation will silently fail with authentication errors whenever credential encryption is actually enabled. The `testDeliveryProvider` function has the same bug (line 130).

---

## 3. Shipment Lifecycle

### Strengths

- **Insert-first pattern:** `createShipment()` writes a `"creating"` placeholder row before calling the external API. This guarantees a DB record exists even if the provider succeeds but the subsequent update fails due to a worker timeout. Well-documented in the JSDoc.
- **Three-outcome handling:** Success (update with tracking info), provider rejection (mark as `"failed"` with `"provider_rejected"`), and exception (mark as `"failed"` with `"exception"`). All paths update the placeholder row.
- **Order enrichment:** Item count and description are fetched from `orderItems` + `products` join and passed to providers, giving couriers useful package metadata.
- **Validation error surfacing:** Both Pathao and Steadfast providers extract field-level validation errors from provider responses and include them in the error message (e.g., `"Pathao: Invalid phone -- recipient_phone: ['Phone number is invalid']"`).

### Issues

**P2 - No idempotency guard on shipment creation**

There is no check for whether an active shipment already exists for an order before creating a new one. A double-click or retry could create multiple provider-side shipments for the same order, each incurring real courier costs.

**Fix:** Either check for existing non-failed shipments before calling the provider, or add a unique constraint on `(orderId, providerId)` with a status filter.

**P3 - `checkShipmentStatus` casts `externalId` without null check**

`delivery.service.ts` line 340:
```typescript
const statusResult = await providerInstance.checkShipmentStatus(
    shipment.externalId as string,
);
```

If the shipment is in `"creating"` or `"failed"` state, `externalId` is `null`. The cast to `string` passes `null` to the provider, which will make an API call with `null` in the URL path.

**Fix:** Add a guard: `if (!shipment.externalId) throw new ValidationError("Shipment has no external ID yet")`.

**P3 - `deleteShipmentRecord` does hard delete without cancelling at provider**

`delivery.service.ts` line 377 permanently deletes the DB row but does not call any provider cancellation API. If the shipment is active at the courier, deleting the record means webhook status updates for that consignment will be silently dropped (the webhook handler logs a warning but the shipment is gone).

---

## 4. Webhook Handling

### Strengths

- **KV-based replay protection:** Both Pathao and Steadfast webhooks use `CACHE` KV with 24-hour TTL keys (`delivery_wh:{provider}:{eventId}`) to deduplicate replayed events. Idempotency check happens early in the handler.
- **Provider-specific verification:** `webhook-auth.ts` implements three strategies: (1) Pathao X-PATHAO-Signature header match, (2) Steadfast Authorization Bearer token, (3) Generic HMAC-SHA256 fallback. Uses `timingSafeEqual` to prevent timing attacks.
- **Graceful degradation:** When no webhookSecret is configured, the middleware logs a `SECURITY WARNING` but still accepts the request, enabling gradual rollout.
- **Webhook event recording:** Both handlers call `recordWebhookEvent()` for audit trail, storing consignment ID, event type, normalized status, and previous status.
- **Pathao integration test support:** The handler recognizes `event: "webhook_integration"` and returns the required 202 + secret header for Pathao's verification flow.
- **Steadfast tracking_update handling:** Tracking messages are stored in metadata without changing shipment status, correctly distinguishing informational updates from status changes.

### Issues

**P2 - Webhook auth reads plaintext credentials from DB**

`webhook-auth.ts` line 83:
```typescript
const credentials: Record<string, unknown> = provider.credentials
    ? JSON.parse(provider.credentials)
    : {};
```

If credentials are encrypted (via `encryptCredentials`), `JSON.parse` will fail on the encrypted blob. The middleware does not call `decryptCredentialsGraceful`. This means webhook signature verification is broken when encryption is enabled.

**Fix:** Import and call `decryptCredentialsGraceful(provider.credentials, env.CREDENTIAL_ENCRYPTION_KEY ?? env.JWT_SECRET)` before parsing.

**P2 - Steadfast dedup key includes `notification_type` which may differ for same event**

The Steadfast KV key is `delivery_wh:steadfast:${consignmentIdRaw}_${notificationType || "unknown"}`. If Steadfast sends the same status change first as `tracking_update` then as `delivery_status`, both get through because the keys differ. The `tracking_update` handler does not prevent the subsequent `delivery_status` from re-processing the same logical event.

**P3 - Pathao webhook does not filter by `isActive` when looking up provider**

`webhook-auth.ts` line 75 queries `eq(deliveryProviders.type, providerType)` without filtering `isActive`. If multiple providers of the same type exist (e.g., a disabled old one and an active new one), the query may return the wrong provider's credentials, causing signature verification to fail against the wrong secret.

**Fix:** Add `eq(deliveryProviders.isActive, true)` to the query or use `orderBy(desc(deliveryProviders.updatedAt)).limit(1)`.

---

## 5. Status Mapping

### Strengths

- **Comprehensive mapping:** `PATHAO_STATUS_MAP` covers 26 statuses across both webhook event names (`order.delivered`) and API response values (`Delivered`, `delivery_failed`). Normalization handles case and delimiter differences.
- **Standardized enum:** `ShipmentStatusCode` defines 14 canonical statuses covering the full delivery lifecycle including partial delivery, pickup failures, and hold states.
- **Fallback with logging:** Unknown statuses map to `UNKNOWN` with a `console.warn` including both raw and normalized forms, aiding debugging.

### Issues

**P3 - Steadfast missing `in_transit` and `out_for_delivery` statuses**

The `STEADFAST_STATUS_MAP` only has 8 entries. If Steadfast ever sends statuses like `"shipped"`, `"in_transit"`, or `"out_for_delivery"`, they would map to `UNKNOWN`. The map seems sparse compared to Pathao's 26 entries.

**P3 - `tracking.ts` shipment-to-order mapping duplicates logic from `status-mapper.ts`**

`updateOrderStatusFromShipment()` in `tracking.ts` has its own switch statement mapping shipment statuses to order statuses (`picked_up` -> `shipped`, `delivered` -> `delivered`). This is a second layer of mapping that uses different status string values than `ShipmentStatusCode` (e.g., it matches `"picked_up"` but the enum is `PICKED_UP = "picked_up"` -- same string, but the switch doesn't reference the enum). If the canonical status strings ever change, this switch would silently stop matching.

**Fix:** Use `ShipmentStatusCode` enum values in the switch cases.

---

## 6. Location Management

### Strengths

- **Three-level hierarchy:** The `deliveryLocations` table supports city > zone > area with self-referential `parentId` FK and a `type` enum. Soft-delete via `deletedAt`.
- **External ID mapping:** The `externalIds` JSON column maps internal locations to provider-specific numeric IDs (`{ "pathao": 123 }`), enabling multi-provider support without separate mapping tables.
- **Pathao bulk import:** The `pathao-location-import.ts` is a well-engineered chunked import system using KV for progress persistence, parallel API calls with concurrency limiting (8 concurrent), and incremental processing (30 zones per chunk). It handles name-based matching for manually-created locations and avoids duplicates.
- **Admin UI:** The locations container has tabbed navigation (cities/zones/areas), parent filtering, search, pagination, bulk select/delete, and a Pathao import flow with progress banner, retry, and reset. Well-decomposed into `LocationsTable`, `LocationFormDialog`, `PathaoImportPanel`, and `DeleteConfirmationDialogs`.

### Issues

**P2 - Location search uses `LIKE` with unsanitized input (SQL injection risk)**

`locations.ts` line 79:
```typescript
like(deliveryLocations.name, `%${query}%`)
```

And in the API route `delivery-locations.ts` line 64:
```typescript
like(deliveryLocations.name, `%${search.trim()}%`)
```

While Drizzle ORM parameterizes queries and prevents direct SQL injection, the `%` and `_` characters in the search input are not escaped. A user searching for `%` or `_` would get unexpected results. Not a security vulnerability with D1/SQLite, but a correctness issue.

**P2 - `DELETE /all` is a permanent hard delete exposed as a single endpoint**

`delivery-locations.ts` line 140:
```typescript
await db.delete(deliveryLocations);
```

This permanently deletes every delivery location with a single API call. No confirmation token, no rate limiting, no audit log. While the admin UI shows a confirmation dialog, the API endpoint itself has no protection against accidental calls.

**P3 - `bulkUpsert` in import does one-by-one DB writes**

`pathao-location-import.ts` lines 223-249 iterate updates and inserts individually rather than using `db.batch()`. For large imports (thousands of areas), this is O(n) round trips to D1. The comment says "batched" but the implementation is sequential.

---

## 7. Credential Security

### Strengths

- **AES-256-GCM encryption:** `credential-encryption.ts` uses proper authenticated encryption with random 12-byte IVs. Format is `base64(iv):base64(ciphertext)`.
- **Graceful migration:** `decryptCredentialsGraceful` allows mixed plaintext/encrypted credentials during migration -- if decryption fails, it returns the raw value.
- **Masked API responses:** `delivery-providers.ts` route masks sensitive fields (`clientSecret`, `password`, `apiKey`, `secretKey`) with `"..."` before sending to the admin UI. The `unmaskedCredentials` function restores masked fields from the existing DB value on update.
- **Encryption key fallback:** `getEncryptionKey()` prefers `CREDENTIAL_ENCRYPTION_KEY` and falls back to `JWT_SECRET`, avoiding a hard requirement for a new secret during initial setup.

### Issues

**P1 - Encryption key not threaded through shipment/webhook code paths (reiterated from Section 3)**

The encryption key is only used in the `delivery-providers.ts` admin route (via `getEncryptionKey(c.env)`). The shipment creation flow (`delivery.service.ts:createShipment` -> `factory.ts:createProvider`) and webhook verification (`webhook-auth.ts`) never receive or use an encryption key. If credentials are encrypted, these code paths will fail.

**P3 - Admin UI stores `webhookSecret` in credentials alongside API keys**

The webhook secret is stored in the same `credentials` JSON object as the API authentication keys. This means it gets encrypted along with everything else, which is correct for at-rest security but creates a coupling -- the webhook auth middleware needs to decrypt the entire credentials blob just to check a webhook signature.

---

## 8. Error Handling

### Strengths

- **Error classes:** Service functions use `NotFoundError`, `ValidationError`, `ServiceUnavailableError` from the shared errors module, enabling the API layer to return correct HTTP status codes.
- **Provider error wrapping:** Both providers catch all exceptions and return structured `ShipmentResult` objects with `success: false` and descriptive messages, never throwing raw errors to the service layer.
- **HTML error page handling:** Both Pathao (`checkShipmentStatus`) and Steadfast (`createShipment`) detect HTML error responses from provider APIs and extract the `<title>` tag for a human-readable error message.
- **Webhook error isolation:** Webhook handlers catch all errors and return 500 with a generic message, never leaking internal details to the provider.

### Issues

**P2 - `tracking.ts:updateOrderStatusFromShipment` swallows all errors**

Line 122:
```typescript
} catch (error: unknown) {
    console.error("Error updating order status from shipment:", error);
    return null;
}
```

If the inventory transition or order status update fails (e.g., due to a stock version conflict), the error is silently swallowed. The webhook handler has no way to know the order update failed, and the status change is lost. This could leave shipment status and order status out of sync.

**Fix:** Let the error propagate, or at minimum return an error indicator that the webhook handler can use to avoid marking the KV dedup key (so the webhook will be retried).

**P3 - Double `getAccessToken()` call in Pathao `testConnection`**

`providers/pathao.ts` lines 112-115:
```typescript
await this.getAccessToken();
if (this.config.storeId) {
    const token = await this.getAccessToken();
```

The first call authenticates to verify credentials. The second call (inside the `if`) gets the token again. Since `getAccessToken()` caches the token, this is just a wasted call, not a bug, but it reads as if the intent was to use the result of the first call.

---

## 9. Admin UI

### Strengths

- **Well-decomposed components:** The delivery providers UI is split into `ProviderListSidebar`, `ProviderDetailPanel`, and `ProviderIcon`, connected by `DeliveryProvidersContainer`. The locations UI uses a custom hook (`useDeliveryLocations`) to separate state logic from presentation.
- **Webhook configuration UX:** The provider detail panel includes webhook URL generation, secret generation/rotation, copy-to-clipboard, and inline setup instructions per provider type. This is a polished workflow.
- **Integration guide accordion:** Each provider type has contextual documentation in the detail panel explaining credentials, store IDs, and location mapping requirements.
- **Import progress banner:** Real-time progress with phase indicators, stats (created/updated counts), retry and reset buttons. Persists import state in KV so a page refresh resumes the import.

### Issues

**P2 - `DeliveryShipmentManager` uses `window.shipmentActions` bridge**

The shipment manager component relies on `window.shipmentActions` being set by an Astro page script. This is a fragile coupling -- if the page script fails to load or the global isn't set, all CRUD operations fail with a toast error. The component should receive API functions as props or use a service layer.

**P3 - Shipment table uses hardcoded light-mode classes**

`DeliveryShipmentManager.tsx` uses `bg-white`, `bg-gray-50`, `text-gray-500`, `divide-gray-200` instead of Tailwind's semantic classes (`bg-card`, `text-muted-foreground`, etc.). This breaks dark mode.

**P3 - COD amount default calculation inconsistent**

`DeliveryShipmentManager.tsx` line 43:
```typescript
order.totalAmount + order.shippingCharge - (order.discountAmount || 0)
```

But providers compute it as:
```typescript
order.balanceDue ?? (order.totalAmount - (order.paidAmount || 0))
```

The admin UI default includes shipping charge and subtracts discount, while the provider uses `balanceDue` (which accounts for partial payments). If the admin doesn't change the default, the COD amount from the UI could be wrong when the order has partial payments.

---

## 10. Database Schema

### Strengths

- **Proper FK relationships:** `deliveryShipments.orderId` references `orders.id` with `CASCADE` delete. `providerId` references `deliveryProviders.id` with `SET NULL` delete (preserves shipment records when a provider is removed).
- **Compound index:** `delivery_shipments_provider_status_idx` on `(providerId, status)` supports efficient queries for active shipments by provider.
- **Flexible metadata:** The `metadata` text column stores provider-specific data (tracking info, webhook payloads, error messages) as JSON without requiring schema migrations.
- **Soft-delete on locations:** `deletedAt` column enables recovery of accidentally deleted location hierarchies.

### Issues

**P2 - Missing index on `deliveryShipments.orderId`**

The `getShipments(db, orderId)` function and webhook handlers query by `orderId`, but there is no index. The only index is `(providerId, status)`. For orders with many shipments or tables with many rows, this is a sequential scan.

**Fix:** Add `index("delivery_shipments_order_id_idx").on(table.orderId)` to the schema.

**P2 - Missing index on `deliveryShipments.externalId`**

Both webhook handlers query by `externalId` (`eq(deliveryShipments.externalId, consignmentId)`). Without an index, every webhook triggers a table scan.

**Fix:** Add `index("delivery_shipments_external_id_idx").on(table.externalId)`.

**P3 - `deliveryProviders.type` has no enum constraint**

The column is `text("type").notNull()` but the database does not enforce valid values. The TypeScript `DeliveryProviderType` enum exists at the application level, but malformed data could be inserted directly into D1.

---

## 11. Summary of Issues

### P1 - Must Fix

| # | Issue | Location | Description |
|---|-------|----------|-------------|
| 1 | Singleton `db` import in PathaoProvider | `providers/pathao.ts:14` | Uses module-level `db` instead of request-scoped instance; violates DI pattern, breaks testability |
| 2 | Encryption key not threaded to shipment/webhook paths | `delivery.service.ts:216`, `webhook-auth.ts:83` | Credential encryption is enabled on save but decryption is missing on read in critical paths; if encryption is active, shipments and webhook auth fail |

### P2 - Should Fix

| # | Issue | Location | Description |
|---|-------|----------|-------------|
| 3 | No idempotency guard on shipment creation | `delivery.service.ts:148` | Double-click can create duplicate courier shipments with real cost |
| 4 | `checkShipmentStatus` null `externalId` cast | `delivery.service.ts:340` | Passes `null as string` to provider API when shipment has no external ID |
| 5 | Webhook auth doesn't decrypt credentials | `webhook-auth.ts:83` | JSON.parse on encrypted blob will throw if encryption is enabled |
| 6 | Steadfast dedup key collision risk | `webhooks/steadfast.ts:51` | Same event arriving as `tracking_update` and `delivery_status` bypasses dedup |
| 7 | Webhook auth doesn't filter by `isActive` | `webhook-auth.ts:75` | May match disabled provider, causing signature verification against wrong secret |
| 8 | `updateOrderStatusFromShipment` swallows errors | `tracking.ts:122` | Failed inventory/order updates are silently lost; shipment and order status diverge |
| 9 | Missing `orderId` index on `deliveryShipments` | `schema/delivery.ts` | Table scan on every order shipment lookup and webhook handler |
| 10 | Missing `externalId` index on `deliveryShipments` | `schema/delivery.ts` | Table scan on every webhook event |
| 11 | `DELETE /all` locations has no safeguard | `delivery-locations.ts:140` | Permanent deletion of all locations with a single unauthenticated-beyond-admin API call |
| 12 | `DeliveryShipmentManager` window bridge fragility | `DeliveryShipmentManager.tsx:79` | Relies on global `window.shipmentActions` set by page script |
| 13 | Location search LIKE wildcards unescaped | `locations.ts:79` | `%` and `_` in search input produce incorrect results |
| 14 | Steadfast `_config` parameter unused | `providers/steadfast.ts:21` | `defaultCodAmount` config has no effect; misleading UI field |

### P3 - Nice to Fix

| # | Issue | Location | Description |
|---|-------|----------|-------------|
| 15 | `deleteShipmentRecord` doesn't cancel at provider | `delivery.service.ts:377` | Active courier shipments continue after DB record deleted |
| 16 | Steadfast status map is sparse | `status-mapper.ts:115` | Missing common in-transit statuses |
| 17 | `tracking.ts` doesn't use `ShipmentStatusCode` enum | `tracking.ts:43` | Raw string matching in switch; brittle if enum values change |
| 18 | `bulkUpsert` does sequential DB writes | `pathao-location-import.ts:223` | Could use `db.batch()` for O(1) round trips |
| 19 | Shipment table hardcoded light-mode colors | `DeliveryShipmentManager.tsx:352` | Breaks dark mode |
| 20 | COD amount default mismatch between UI and provider | `DeliveryShipmentManager.tsx:43` | UI includes shipping, provider uses `balanceDue` |
| 21 | Double `getAccessToken()` in Pathao testConnection | `providers/pathao.ts:112-115` | Redundant call; cosmetic |
| 22 | `deliveryProviders.type` has no DB-level enum | `schema/delivery.ts:33` | Accepts any string value at the database level |
| 23 | `notifyShipmentStatusChange` is a stub | `tracking.ts:135` | Placeholder that only logs; no actual notification sent |

---

## 12. Recommendations

### Immediate (next session)

1. **Thread encryption key through all provider code paths.** Add `encryptionKey` parameter to `createShipment`, `checkShipmentStatus`, and `testDeliveryProvider` in `delivery.service.ts`. Pass it from the API routes via `getEncryptionKey(c.env)`. Update `webhook-auth.ts` to decrypt credentials before parsing. This is the highest-risk bug -- it will surface the moment someone enables `CREDENTIAL_ENCRYPTION_KEY`.

2. **Fix PathaoProvider's singleton `db` import.** Change `createProvider()` to accept a `db` parameter, store it on the provider instance, and pass it to `getExternalLocationIds()`. Alternatively, move the location ID lookup into `delivery.service.ts:createShipment()` and pass the resolved IDs to the provider via `ShipmentOptions`.

3. **Add missing indexes.** Create a migration adding:
   - `delivery_shipments_order_id_idx` on `deliveryShipments.orderId`
   - `delivery_shipments_external_id_idx` on `deliveryShipments.externalId`

### Short-term

4. **Add idempotency guard to `createShipment`.** Before calling the provider, check for existing shipments with status not in `["failed", "cancelled"]`. Return an error if one exists.

5. **Guard `checkShipmentStatus` against null `externalId`.** Throw `ValidationError` instead of passing null to the provider API.

6. **Fix webhook auth `isActive` filter.** Filter providers by `isActive = true` in the webhook middleware query.

7. **Propagate errors from `updateOrderStatusFromShipment`.** Return error indicators rather than swallowing; let webhook handlers decide retry behavior.

### Medium-term

8. **Migrate `DeliveryShipmentManager` from `window` bridge to props/hooks pattern.** Pass API client functions as component props, matching the pattern used in delivery providers and locations.

9. **Wire `SteadfastConfig.defaultCodAmount` into the provider** as a fallback when neither `options.codAmount` nor `order.balanceDue` is available, or remove the config field from the schema and UI.

10. **Enrich Steadfast status map** with additional transitional statuses to reduce `UNKNOWN` mappings in production.

11. **Implement `notifyShipmentStatusChange`** using the existing `ORDER_NOTIFICATIONS_QUEUE` pattern, so customers receive delivery updates via email/FCM.

---

## 13. LLM-Friendliness Assessment

**Score: 8/10**

Strengths:
- Clear interface file (`provider.ts`) serves as the single contract
- Factory pattern (`factory.ts`) with explicit switch/case is easy to extend
- Status mapper has comprehensive lookup tables with inline comments explaining format differences
- Well-documented JSDoc on key functions (insert-first pattern, webhook verification strategies)

Weaknesses:
- The encryption key threading gap is a trap -- the code looks correct at each layer but fails at integration
- The `tracking.ts` status-to-order mapping is a separate concern mixed into the delivery module; an LLM might miss it when implementing a new provider
- The `window.shipmentActions` bridge in `DeliveryShipmentManager` is non-obvious; an LLM would likely try to import API functions directly
