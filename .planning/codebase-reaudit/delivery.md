# Delivery Domain Re-Audit

**Date:** 2026-03-21
**Previous Audit:** 2026-03-20
**Scope:** Complete vertical slice -- schema, core services, API routes, webhooks, webhook auth, credential encryption, admin UI components.

---

## Previous Finding Status

### Issue 1: Dual Provider Interface -- Two Competing Type Systems
**Status: STILL OPEN**

Both interfaces remain exactly as described:
- `packages/core/src/modules/delivery/provider.ts` -- `DeliveryProviderInterface` (active, used by Pathao/Steadfast)
- `packages/core/src/providers/delivery/types.ts` -- `DeliveryProvider` (universal system, zero implementations)

The two `ShipmentResult` types remain incompatible:
- Legacy (`packages/core/src/modules/delivery/types.ts`): `{ success: boolean; message: string; data?: { externalId?, ... } }`
- New (`packages/core/src/providers/delivery/types.ts`): `{ externalId: string; trackingId?: string; status: ShipmentStatusCode; ... }`

The two `ShipmentStatusCode` definitions remain incompatible:
- Legacy (`packages/core/src/modules/delivery/status-mapper.ts`): enum with 14 values
- New (`packages/core/src/providers/delivery/types.ts`): union type with 8 values

CLAUDE.md "Known Backlog" still acknowledges this. No work has been done to reconcile.

### Issue 2: Inconsistent Timestamp Generation -- `CURRENT_TIMESTAMP` vs `unixepoch()`
**Status: FIXED**

All `CURRENT_TIMESTAMP` references in `packages/core/src/modules/delivery/locations.ts` have been replaced with `sql\`(unixepoch())\``:
- `createLocation()` (lines 108-109): uses `sql\`(unixepoch())\``
- `updateLocation()` (line 118): uses `sql\`(unixepoch())\``
- `deleteLocation()` (lines 147-148): uses `sql\`(unixepoch())\``

All `CURRENT_TIMESTAMP` references in `packages/core/src/modules/delivery/pathao-location-import.ts` have been replaced with `sql\`(unixepoch())\`` (line 233).

However, a new minor inconsistency exists in `apps/api/src/routes/admin/settings/delivery-locations.ts`:
- Lines 197, 260, 310 use `sql\`(cast(strftime('%s','now') as int))\`` instead of `sql\`(unixepoch())\``
- Functionally equivalent (both produce Unix epoch seconds as integers), but stylistically inconsistent with the codebase convention of using `unixepoch()`.

### Issue 3: Webhook Auth Falls Through to "Allow All" When No Secret Configured
**Status: FIXED**

`apps/api/src/middleware/webhook-auth.ts` lines 221-228 now **reject** requests when no webhook security is configured:

```typescript
// --- Strategy 3: No security configured --- REJECT ---
console.error(
    `[webhook-auth] [${providerType}] REJECTED: No webhookSecret or allowedWebhookIps configured. ` +
    `Set credentials.webhookSecret or config.allowedWebhookIps for this provider.`,
);
return { verified: false, credentials, config, reason: "No webhook authentication configured for this provider" };
```

This is exactly the fix recommended in the previous audit.

### Issue 4: `as any` Type Casts in API Routes
**Status: STILL OPEN**

The `as any` casts remain in:
- `apps/api/src/routes/admin/shipments.ts` line 167: `}) as any);`
- `apps/api/src/routes/admin/settings/delivery-providers.ts` lines 149, 234: `}) as any);`
- `apps/api/src/routes/admin/settings/delivery-locations.ts` line 145: `}) as any);`

Additionally, `(c: any)` casts remain at handler entry points in the same files. The count is reduced slightly (no more `c.env as Record<string, unknown>` on every route handler), but the core issue persists.

### Issue 5: Unused Schema Columns
**Status: STILL OPEN**

All five columns on `deliveryShipments` in `packages/database/src/schema/delivery.ts` remain unused:
- `trackingUrl` (line 56) -- never populated
- `courierName` (line 57) -- never populated
- `shipmentItems` (line 63) -- never populated
- `shipmentAmount` (line 64) -- never populated
- `isFinalShipment` (line 65) -- never set to `true`

No changes observed.

### Issue 6: Pathao Token Caching -- Dual Implementation
**Status: STILL OPEN**

Two independent caching mechanisms remain:
- `packages/core/src/modules/delivery/providers/pathao.ts` lines 25-26: instance-level cache with 1-hour margin
- `packages/core/src/modules/delivery/pathao-location-import.ts` line 60: module-level cache with 10-minute margin

No changes observed.

### Issue 7: `SteadfastProvider.testConnection()` Mutates Credentials
**Status: STILL OPEN**

`packages/core/src/modules/delivery/providers/steadfast.ts` lines 56-61 still mutates `this.credentials` inside `testConnection()`:

```typescript
this.credentials = {
    ...this.credentials,
    apiKey: trimmedApiKey,
    secretKey: trimmedSecretKey,
    baseUrl: this.credentials.baseUrl.trim(),
};
```

However, the `getHeaders()` method (lines 107-116) also trims on every call, which mitigates the most dangerous scenario (untrimmed credentials in API calls). The mutation in `testConnection()` is still unnecessary and fragile.

### Issue 8: `testConnection()` Double-Consumes Response Body
**Status: STILL OPEN**

`packages/core/src/modules/delivery/providers/steadfast.ts` lines 71-93 still has the same pattern:

```typescript
try {
    await response.text(); // consume body once
} catch (readError: unknown) { /* Ignore */ }

if (response.status === 200 || response.status === 404) {
    return { success: true, message: "Connection successful" };
} else {
    try {
        const data = await response.json() as Record<string, unknown>; // ERROR: body already consumed
```

The response body is consumed by `response.text()`, then `response.json()` is attempted in the error branch. The error path for non-200/404 responses is still broken -- error details from Steadfast are lost.

### Issue 9: Error Handling Inconsistency: Return vs Throw
**Status: STILL OPEN**

`packages/core/src/modules/delivery/delivery.service.ts` `createShipment()` (lines 160-174) still returns `{ success: false, message: "..." }` for order-not-found and provider-not-found cases, while `checkShipmentStatus()` (lines 321-323) and `testDeliveryProvider()` (lines 124-126) throw `NotFoundError`.

However, a positive change was observed: `delivery.service.ts` line 9 now imports `NotFoundError, ValidationError, ServiceUnavailableError` from `@scalius/core/errors`, showing the throw pattern is used elsewhere in the same file. The `createShipment` function is the outlier.

### Issue 10: Location Search Uses LIKE Instead of FTS5
**Status: STILL OPEN**

`packages/core/src/modules/delivery/locations.ts` line 79 still uses:
```typescript
like(deliveryLocations.name, `%${query}%`)
```

Additionally, `apps/api/src/routes/admin/settings/delivery-locations.ts` line 81 also uses:
```typescript
like(deliveryLocations.name, `%${search.trim()}%`)
```

No FTS5 table or helper usage for delivery locations.

### Issue 11: `saveDeliveryProvider()` Does SELECT-then-INSERT/UPDATE (Non-Atomic)
**Status: STILL OPEN**

`packages/core/src/modules/delivery/delivery.service.ts` lines 78-105 still use the TOCTOU pattern:

```typescript
const existingProvider = await getDeliveryProvider(db, providerId);
if (existingProvider) {
    await db.update(...);
} else {
    await db.insert(...);
}
```

No `onConflictDoUpdate()` usage detected.

### Issue 12: DeliveryShipmentManager Uses `window.shipmentActions` Bridge
**Status: STILL OPEN**

`apps/admin/src/components/admin/DeliveryShipmentManager.tsx` lines 20-29 still declares the `window.shipmentActions` global bridge. A search for `import.*DeliveryShipmentManager` across the entire admin app returns zero results -- the component is not imported or rendered anywhere.

The component is dead code. Neither the `window.shipmentActions` bridge nor the component itself is used.

### Issue 13: Duplicate Status Display Logic
**Status: STILL OPEN**

`getRelativeTime()` is still duplicated verbatim in:
- `apps/admin/src/components/admin/ShipmentStatusIndicator.tsx` line 24
- `apps/admin/src/components/admin/ShipmentList.tsx` line 186
- `apps/admin/src/components/admin/CacheManager.tsx` line 78 (different signature -- takes `number | null` instead of `string`)

`ShipmentStatusBadge.tsx` and `ShipmentStatusIndicator.tsx` still both map statuses to colors independently.

### Issue 14: `notifyShipmentStatusChange()` is a Placeholder
**Status: STILL OPEN**

`packages/core/src/modules/delivery/tracking.ts` lines 139-188 remains a placeholder:

```typescript
// This is a placeholder for future notification implementation
console.log(`Status change notification for shipment ${shipmentId}...`);
```

Still called from both webhook handlers and the manual status check route, giving the false impression that notifications are sent.

### Issue 15: Location Import -- Individual DB Writes Instead of Batch
**Status: STILL OPEN**

`packages/core/src/modules/delivery/pathao-location-import.ts` lines 222-249 still processes updates and inserts individually in loops:

```typescript
for (const u of updates) {
    await db.update(deliveryLocations).set({...}).where(...);
}
for (const ins of inserts) {
    await db.insert(deliveryLocations).values({...});
}
```

No `db.batch()` usage detected.

### Issue 16: `getExternalLocationIds()` Makes 3 Sequential DB Queries
**Status: STILL OPEN**

`packages/core/src/modules/delivery/locations.ts` lines 262-274 still makes 3 sequential calls to `getExternalLocationId()`, each performing a separate DB query.

### Issue 17: Webhook Handlers Do Not Use `db.batch()`
**Status: STILL OPEN**

Both `apps/api/src/routes/webhooks/pathao.ts` (lines 130-157) and `apps/api/src/routes/webhooks/steadfast.ts` (lines 153-180) still perform sequential DB writes: shipment update, order status update, webhook event recording, KV write.

### Issue 18: Webhook Idempotency Key Doesn't Include Timestamp
**Status: STILL OPEN**

- `apps/api/src/routes/webhooks/pathao.ts` line 86: `const eventId = \`${consignmentId}_${event}\``
- `apps/api/src/routes/webhooks/steadfast.ts` line 50: `const kvKey = \`delivery_wh:steadfast:${consignmentIdRaw}_${notificationType || "unknown"}\``

No timestamp or sequence number in the idempotency key.

### Issue 19: `checkShipmentStatus()` Doesn't Validate `externalId` Existence
**Status: STILL OPEN**

`packages/core/src/modules/delivery/delivery.service.ts` line 340 still has:
```typescript
const statusResult = await providerInstance.checkShipmentStatus(
    shipment.externalId as string,
);
```

The `as string` cast bypasses the null check. A new guard was added for `providerId` null check (lines 326-328), but no guard exists for `externalId`.

### Issue 20: Provider Deletion Doesn't Check for Active Shipments
**Status: STILL OPEN**

`apps/api/src/routes/admin/settings/delivery-providers.ts` lines 385-394 still deletes without checking for existing shipments:

```typescript
app.openapi(deleteProviderRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await db.delete(deliveryProviders).where(eq(deliveryProviders.id, id));
    return ok(c, {});
});
```

### Issue 21: Location `DELETE /all` is a Hard Delete Without Confirmation
**Status: FIXED**

`apps/api/src/routes/admin/settings/delivery-locations.ts` lines 148-171 now requires a `confirmDeleteAll: true` in the request body:

```typescript
const deleteAllRoute = createRoute({
    ...
    request: {
        body: { content: { "application/json": { schema: z.object({ confirmDeleteAll: z.literal(true) }) } } }
    },
    ...
});

app.openapi(deleteAllRoute, async (c) => {
    const { confirmDeleteAll } = c.req.valid("json");
    if (!confirmDeleteAll) {
        throw new ValidationError("Must confirm deletion by setting confirmDeleteAll: true");
    }
    ...
});
```

This is exactly the safeguard recommended in the previous audit.

---

## New Issues Found

### NEW-1: Update Provider Route Missing Encryption Key -- Credentials Saved in Plaintext

**Files:**
- `apps/api/src/routes/admin/settings/delivery-providers.ts` line 213-220

**Issue:** The PUT (update) route calls `saveDeliveryProvider()` without passing the encryption key:

```typescript
const savedProvider = await saveDeliveryProvider(db, {
    id: validated.id,
    name: validated.name,
    ...
    credentials: unmaskedCreds,
    ...
}); // <-- no encryptionKey parameter!
```

Compare with the POST (create) route at line 136 which correctly passes it:
```typescript
const savedProvider = await saveDeliveryProvider(db, provider, getEncryptionKey(c.env as Record<string, unknown>));
```

**Impact:** Every time a provider is updated (name change, toggle active, credential update), the credentials are saved in plaintext instead of being encrypted. This silently downgrades the security of previously encrypted credentials. The `decryptCredentialsGraceful()` function will still work (it gracefully handles plaintext), masking the problem -- but credentials are now stored unencrypted in D1.

**Fix approach:** Add `getEncryptionKey(c.env as Record<string, unknown>)` as the third argument to `saveDeliveryProvider()` on line 220.

### NEW-2: Timestamp Inconsistency Between Core Services and API Routes

**Files:**
- `packages/core/src/modules/delivery/delivery.service.ts`: uses `sql\`unixepoch()\``
- `packages/core/src/modules/delivery/locations.ts`: uses `sql\`(unixepoch())\``
- `apps/api/src/routes/admin/settings/delivery-locations.ts` lines 197, 260, 310: uses `sql\`(cast(strftime('%s','now') as int))\``
- `apps/api/src/routes/webhooks/pathao.ts` lines 135-136: uses `new Date()` for `lastChecked` and `updatedAt`
- `apps/api/src/routes/webhooks/steadfast.ts` lines 84, 158-159: uses `new Date()` for `lastChecked` and `updatedAt`
- `packages/core/src/modules/delivery/tracking.ts` line 107: uses `new Date()` for `updatedAt`

All three approaches (`unixepoch()`, `cast(strftime('%s','now') as int)`, and `new Date()`) produce correct results because Drizzle's `{ mode: "timestamp" }` converts `Date` objects to Unix seconds. But the codebase uses three different spellings for the same operation, making it harder for new developers to know which to use.

**Impact:** Low -- functionally correct. But consistency is a convention concern.

**Fix approach:** Standardize on `sql\`(unixepoch())\`` per CLAUDE.md convention. Or accept `new Date()` in webhook handlers where it's more readable.

### NEW-3: `unmaskedCredentials()` Silently Returns Masked Values on Parse Failure

**Files:**
- `apps/api/src/routes/admin/settings/delivery-providers.ts` lines 15-35

```typescript
function unmaskedCredentials(newCredentials: string, existingCredentials?: string): string {
    try {
        const newCreds = JSON.parse(newCredentials);
        if (!existingCredentials) return newCredentials;
        const existingCreds = JSON.parse(existingCredentials);
        ...
    } catch (e: unknown) {
        return newCredentials; // Returns masked credentials on ANY parse error
    }
}
```

**Issue:** If `existingCredentials` is malformed JSON (e.g., corrupted encrypted string), the catch block returns `newCredentials` unchanged. If `newCredentials` contains `MASKED_VALUE` placeholders (which it will, since the UI sends masked values back), those masked placeholders get saved to the database as the actual credential values.

**Impact:** If encryption/decryption produces garbled output, a provider update will silently replace real credentials with the literal string "............" (the masked value). The admin would see "Connection successful" replaced by auth failures on the next API call with no indication of what happened.

**Fix approach:** If `existingCredentials` parsing fails, throw an error or log a warning and refuse to save, rather than silently using the masked values.

### NEW-4: Steadfast Webhook Uses `rawStatus` Directly in Idempotency Key

**Files:**
- `apps/api/src/routes/webhooks/steadfast.ts` line 50

```typescript
const kvKey = `delivery_wh:steadfast:${consignmentIdRaw}_${notificationType || "unknown"}`;
```

For `delivery_status` notifications, the dedup key uses `notificationType` ("delivery_status") rather than the actual status value. This means if a shipment transitions from "pending" to "delivered" and a second `delivery_status` webhook fires (e.g., for "returned"), the second event is NOT deduplicated because the first KV entry uses the same key `delivery_wh:steadfast:123_delivery_status`.

Wait -- this means the OPPOSITE of issue #18. For Steadfast, the key does NOT include the status at all, so every `delivery_status` for the same consignment within 24 hours IS deduplicated, even if the status changed. The Pathao webhook uses `${consignmentId}_${event}` where `event` is the specific status event (e.g., `order.delivered`), so different events are NOT deduplicated.

**Impact:** Steadfast webhook deduplication is over-aggressive. If a Steadfast shipment transitions between statuses (e.g., `pending` -> `delivered` -> `partial_delivered`) within 24 hours, only the first `delivery_status` notification is processed. All subsequent status changes are silently dropped.

**Fix approach:** Include `rawStatus` in the Steadfast KV key: `delivery_wh:steadfast:${consignmentIdRaw}_${notificationType}_${rawStatus}`.

---

## Summary

| # | Issue | Previous Status | Current Status |
|---|-------|----------------|----------------|
| 1 | Dual provider interface | Critical | **STILL OPEN** |
| 2 | `CURRENT_TIMESTAMP` in locations | Critical | **FIXED** |
| 3 | Webhook auth fails open | Critical | **FIXED** |
| 4 | `as any` casts in routes | Quality | **STILL OPEN** |
| 5 | Unused schema columns | Quality | **STILL OPEN** |
| 6 | Pathao token dual caching | Quality | **STILL OPEN** |
| 7 | Steadfast testConnection mutates creds | Quality | **STILL OPEN** |
| 8 | testConnection double-consumes body | Quality | **STILL OPEN** |
| 9 | Error handling return vs throw | Pattern | **STILL OPEN** |
| 10 | LIKE instead of FTS5 | Pattern | **STILL OPEN** |
| 11 | SELECT-then-INSERT/UPDATE TOCTOU | Pattern | **STILL OPEN** |
| 12 | DeliveryShipmentManager dead code | Maintainability | **STILL OPEN** |
| 13 | Duplicate getRelativeTime | Maintainability | **STILL OPEN** |
| 14 | Placeholder notification function | Maintainability | **STILL OPEN** |
| 15 | Individual DB writes in import | Performance | **STILL OPEN** |
| 16 | 3 sequential queries for locations | Performance | **STILL OPEN** |
| 17 | No db.batch() in webhooks | Performance | **STILL OPEN** |
| 18 | Idempotency key missing timestamp | Robustness | **STILL OPEN** |
| 19 | externalId null not checked | Robustness | **STILL OPEN** |
| 20 | Provider deletion no active check | Robustness | **STILL OPEN** |
| 21 | DELETE /all no confirmation | Robustness | **FIXED** |
| NEW-1 | Update route missing encryption key | **NEW - Critical** | -- |
| NEW-2 | 3 timestamp spellings | **NEW - Low** | -- |
| NEW-3 | unmaskedCredentials silently saves masked values | **NEW - Medium** | -- |
| NEW-4 | Steadfast webhook over-deduplicates | **NEW - High** | -- |

**Fixed:** 3 of 21 (Issues 2, 3, 21)
**Still Open:** 18 of 21
**New Issues:** 4

---

## Updated Priority List

### Priority 1 (Critical -- Data Loss / Security)

| # | Issue | Files | Effort |
|---|-------|-------|--------|
| NEW-1 | Update route saves credentials in plaintext | `apps/api/src/routes/admin/settings/delivery-providers.ts` line 220 | 5 min |
| 19 | Add null check for `externalId` before status check | `packages/core/src/modules/delivery/delivery.service.ts` line 340 | 5 min |
| NEW-4 | Steadfast webhook over-deduplicates status changes | `apps/api/src/routes/webhooks/steadfast.ts` line 50 | 10 min |

### Priority 2 (Important -- Correctness / Robustness)

| # | Issue | Files | Effort |
|---|-------|-------|--------|
| 8 | Fix double-consumed response body | `packages/core/src/modules/delivery/providers/steadfast.ts` | 15 min |
| 9 | Standardize error handling (throw not return) | `packages/core/src/modules/delivery/delivery.service.ts` | 30 min |
| 18 | Include timestamp in Pathao idempotency key | `apps/api/src/routes/webhooks/pathao.ts` | 10 min |
| 20 | Check for active shipments before provider deletion | `apps/api/src/routes/admin/settings/delivery-providers.ts` | 30 min |
| NEW-3 | unmaskedCredentials fails silent on parse error | `apps/api/src/routes/admin/settings/delivery-providers.ts` | 15 min |
| 7 | Trim credentials in constructor | `packages/core/src/modules/delivery/providers/steadfast.ts` | 10 min |

### Priority 3 (Improvements)

| # | Issue | Files | Effort |
|---|-------|-------|--------|
| 1 | Plan migration from dual provider interface | `provider.ts`, `providers/delivery/types.ts`, providers, `factory.ts` | 4-6 hours |
| 4 | Remove `as any` casts | `shipments.ts`, `delivery-providers.ts`, `delivery-locations.ts` | 2 hours |
| 5 | Populate or drop unused schema columns | Schema, `delivery.service.ts` | 1 hour |
| 11 | Use `onConflictDoUpdate()` in saveDeliveryProvider | `delivery.service.ts` | 30 min |
| 12 | Remove dead DeliveryShipmentManager component | `DeliveryShipmentManager.tsx` | 15 min |
| 13 | Extract getRelativeTime to shared utils | `ShipmentStatusIndicator.tsx`, `ShipmentList.tsx` | 30 min |
| 14 | Integrate notification with queue or rename placeholder | `tracking.ts` | 1-2 hours |
| 15 | Batch location import DB writes | `pathao-location-import.ts` | 1 hour |
| 16 | Single query for external location IDs | `locations.ts` | 30 min |
| 17 | Batch webhook DB operations | `pathao.ts`, `steadfast.ts` webhooks | 1 hour |
| NEW-2 | Standardize timestamp approach | Multiple files | 30 min |
| 6 | Unify Pathao token caching | `providers/pathao.ts`, `pathao-location-import.ts` | 1 hour |
| 10 | Use FTS5 for location search | `locations.ts` | 1 hour |

### Zero Test Coverage (unchanged)

No test files exist for the delivery domain. The same test recommendations from the previous audit apply.

---

## Rating: 5/10

**Rationale:** The fix session addressed the three most security-critical issues (webhook auth reject-by-default, `CURRENT_TIMESTAMP` data corruption, DELETE /all confirmation). However, a new critical issue was introduced (NEW-1: update route saving credentials in plaintext) and a high-impact bug was discovered (NEW-4: Steadfast over-deduplication silently dropping status updates). 18 of the original 21 issues remain open, including the `externalId` null safety issue and the double-consumed response body. The domain is functional but carries significant technical debt. The architectural concern (dual provider interface) is the largest unresolved item and will block clean addition of new delivery providers.

The score reflects: good core architecture and patterns (insert-first, status mapping, webhook verification) offset by accumulated small issues that compound into maintenance burden, plus a newly introduced credential encryption regression.
