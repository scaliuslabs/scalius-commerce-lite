# Customers Domain Audit

**Analysis Date:** 2026-03-20

## Summary

The Customers domain spans a complete vertical slice: database schema, shared validation/phone utilities, core service layer (admin CRUD + storefront OTP auth), API routes (admin + customer-auth), admin UI (list, form, history), storefront client library, and storefront proxy. The domain is well-structured overall, with good separation between admin CRUD and storefront auth concerns, proper E.164 phone normalization, a pluggable OTP transport layer, and thorough FTS5 search. However, there are several non-trivial issues around error handling patterns, non-atomic writes, dead code paths in the route handler, and a duplicated `Customer` type definition across the admin UI.

---

## Critical Issues

### 1. Non-atomic customer + history writes in service layer

**Files:**
- `packages/core/src/modules/customers/customers.service.ts` (lines 167-201, 248-265, 274-291)

`createCustomer()`, `updateCustomer()`, and `deleteCustomer()` each execute two separate `await` calls: one for the customer insert/update and one for the history insert. If the second write fails (e.g., D1 timeout), the customer is modified but no history record exists, silently breaking the audit trail. The codebase already uses `db.batch()` in `listCustomers()` and in the `history` route handler, so the pattern is established.

**Fix:** Wrap each mutation + history insert in `db.batch([...])` for atomicity. Example for `createCustomer()`:

```typescript
await db.batch([
  db.insert(customers).values({ ... }),
  db.insert(customerHistory).values({ ... }),
]);
```

### 2. `updateCustomer()` returns `{ success: true }` -- violates response envelope contract

**File:** `packages/core/src/modules/customers/customers.service.ts` (line 267)

The service returns `{ success: true }` directly. When the route calls `ok(c, {})` (ignoring the service return), this is harmless. But if anyone calls the service directly and passes its return through `ok()`, the response becomes `{ success: true, data: { success: true } }` -- double-wrapping. The CLAUDE.md convention says the `T` passed to `ok(c, T)` must NEVER include `success: true`. The service should return void or `{ updated: true }` -- never use the envelope key `success`.

**Fix:** Change return to `return;` (void) or `return { updated: true };`.

### 3. OTP `StoredOtp.email` field name is misleading for phone-based OTP

**File:** `packages/core/src/modules/customers/customer-auth.service.ts` (lines 43-47, 232-236)

The `StoredOtp` interface has a field called `email` which stores the normalized identifier -- even when that identifier is a phone number:

```typescript
export interface StoredOtp {
  code: string;
  email: string;     // <-- misleading: stores phone when method="phone"
  expiresAt: number;
  attempts: number;
}
```

On line 232, the `sendOtp()` function sets `email: normalizedIdentifier` regardless of method. This creates confusion for any future developer maintaining the code.

**Fix:** Rename `email` to `identifier` in the `StoredOtp` interface and all usages.

---

## Code Quality Issues

### 4. Error throwing uses `Object.assign(new Error(...), { statusCode })` instead of typed error classes

**File:** `packages/core/src/modules/customers/customers.service.ts` (lines 150, 215, 223, 272)

The service throws plain `Error` objects with a manually-assigned `statusCode` property:

```typescript
throw Object.assign(new Error("Customer with this phone number already exists"), { statusCode: 400 });
```

Meanwhile, `customer-auth.service.ts` correctly uses typed error classes (`ValidationError`, `RateLimitError`, `ForbiddenError`) from `@scalius/core/errors`. The admin route handler then catches these with `as { message?: string; statusCode?: number }` casts and re-throws as `ApiError`.

**Fix:** Replace all `Object.assign(new Error(...), { statusCode })` calls with the appropriate `@scalius/core/errors` classes:
- `statusCode: 400` -> `throw new ValidationError("...")`
- `statusCode: 404` -> `throw new NotFoundError("...")`

This eliminates the catch-and-rethrow boilerplate in the route handler.

### 5. Route handler uses `as any` type cast to bypass Hono type checking

**File:** `apps/api/src/routes/admin/customers.ts` (line 89)

The `createCustomerRoute` handler is cast `as any` to work around a Hono/Zod OpenAPI typing issue:

```typescript
app.openapi(createCustomerRoute, (async (c: any) => {
  ...
}) as any);
```

This suppresses all type safety for that handler. Other routes in the same file (list, getById, update, delete, etc.) do NOT use this cast, so this appears to be a localized workaround rather than a systemic need.

**Fix:** Investigate the root cause. It is likely a mismatch between the Zod body schema (`createCustomerSchema` uses a `.transform()` via `phoneNumberSchema`) and Hono's `valid("json")` return type. A potential fix is to use `.pipe()` instead of `.transform()` in the schema, or add a separate request schema without the transform for the OpenAPI spec.

### 6. History route has significant inline business logic in the API layer

**File:** `apps/api/src/routes/admin/customers.ts` (lines 257-363)

The `GET /{id}/history` endpoint contains ~100 lines of business logic directly in the route handler: batch queries, location enrichment, date formatting, data transformation. This violates the "thin HTTP layer" convention from CLAUDE.md. All other customer operations correctly delegate to the service layer.

**Fix:** Extract to `getCustomerHistory(db, id)` in `customers.service.ts`. The route handler should be ~5 lines:

```typescript
const result = await getCustomerHistory(db, id);
if (!result) throw new NotFoundError("Customer not found");
return ok(c, result);
```

### 7. Duplicate `Customer` type definitions across admin UI files

**Files:**
- `apps/admin/src/components/admin/customer-list/hooks/useCustomerListState.ts` (lines 3-21)
- `apps/admin/src/components/admin/CustomerHistoryView.tsx` (lines 46-64)

Both files define their own `Customer` interface with identical fields. Neither imports from the SDK (`@scalius/api-client/types`) or from a shared admin types file.

**Fix:** Define once in a shared types file (e.g., `apps/admin/src/types/api-responses.ts` which already exists) and import from there. Or use the SDK types: `import type { Customer } from "@scalius/api-client/types"`.

---

## Pattern Violations

### 8. `sendOtp` route handler has dead code checking `result.success`

**File:** `apps/api/src/routes/customer-auth.ts` (lines 86-95)

After the service was refactored to throw typed errors instead of returning error objects, the route handler still checks `if (!result.success)`:

```typescript
const result = await sendOtp(db, kv, { method, identifier: identifier!, name, ip });
if (!result.success) {
  // This code path is never reached -- sendOtp throws on failure
  const status = result.httpStatus || 400;
  ...
}
```

The `sendOtp()` function in `customer-auth.service.ts` throws `ValidationError`, `ForbiddenError`, `RateLimitError`, or `ServiceUnavailableError` on any error condition. It always returns `{ success: true, ... }` on the happy path. The same dead code exists in the `verifyOtp` handler (lines 177-185).

**Fix:** Remove the `if (!result.success)` blocks from both handlers. The global error handler in `app.ts` already catches thrown errors and formats them correctly.

### 9. `CustomerForm.tsx` re-defines its own Zod schema instead of using the canonical one

**File:** `apps/admin/src/components/admin/CustomerForm.tsx` (lines 31-51)

The form defines `customerFormSchema` locally instead of importing `createCustomerSchema` from `@scalius/core/modules/customers/customers.validation`. The local schema is subtly different:
- Phone validation: `z.string().min(7).max(16)` (basic length check) vs the canonical `phoneNumberSchema` that uses `libphonenumber-js` validation + E.164 transform
- Includes extra fields: `cityName`, `zoneName`, `areaName` (not in the canonical schema)

This means admin-created customers may bypass E.164 normalization if the form submits a phone number that passes length checks but fails `libphonenumber-js`. The API route's `createCustomerSchema` (which uses the canonical schema with the transform) will catch this, but the UX is worse -- the error appears after submit rather than during form validation.

**Fix:** Import `createCustomerSchema` from `@scalius/core/modules/customers/customers.validation` and extend it with the form-specific fields (`id`, `cityName`, `zoneName`, `areaName`).

### 10. Location name enrichment logic duplicated in three places

**Files:**
- `packages/core/src/modules/customers/customers.service.ts` (`listCustomers` lines 110-128, `createCustomer` lines 152-163, `updateCustomer` lines 226-238)
- `apps/api/src/routes/admin/customers.ts` (`getHistoryRoute` lines 315-333)

The pattern of collecting location IDs, querying `deliveryLocations`, and building a Map is copied 4 times with minor variations. This is a maintenance risk -- if the location model changes, all 4 copies must be updated.

**Fix:** Extract a shared utility:

```typescript
async function resolveLocationNames(db: Database, ids: string[]): Promise<Map<string, string>> { ... }
```

---

## Maintainability Concerns

### 11. `CustomerHistoryView.tsx` is a 639-line monolith

**File:** `apps/admin/src/components/admin/CustomerHistoryView.tsx`

This single file contains: the main component, interfaces, helper functions (`formatDate`, `getInitials`, `getStatusBadgeVariant`, `getStatusIcon`, `getChangeTypeBadgeVariant`), and inline JSX for the profile card, orders table, and change history timeline. Contrast this with the `customer-list/` directory which properly decomposes into `CustomerTable`, `DeleteCustomerDialog`, `hooks/useCustomerListState`, and `hooks/useCustomerListActions`.

**Fix:** Split into:
- `customer-history/CustomerProfile.tsx` -- profile card
- `customer-history/CustomerOrdersTable.tsx` -- orders table with pagination
- `customer-history/ChangeHistoryTimeline.tsx` -- history timeline
- `customer-history/helpers.ts` -- shared formatters

### 12. `index.ts` barrel only exports admin service, not auth service

**File:** `packages/core/src/modules/customers/index.ts`

```typescript
export * from "./customers.service";
```

`customer-auth.service.ts` must be imported by its full path: `@scalius/core/modules/customers/customer-auth.service`. This is inconsistent with how the import conventions in CLAUDE.md suggest `@scalius/core/modules/customers` should be the canonical import path. The README acknowledges this as a known gap.

### 13. `getCustomerOrders()` hardcodes `.limit(50)` with no pagination

**File:** `packages/core/src/modules/customers/customers.service.ts` (line 361)

The storefront's customer orders endpoint retrieves at most 50 orders with no pagination support. For high-volume customers, this silently drops older orders. The admin `GET /{id}/history` route also has no order pagination.

**Fix:** Add `page`/`limit` parameters to `getCustomerOrders()` and return a pagination object alongside the orders.

---

## Performance & Scalability

### 14. `listCustomers()` performs N+1-ish location enrichment query after batch

**File:** `packages/core/src/modules/customers/customers.service.ts` (lines 109-128)

After the batched count+results query, there is a separate query to `deliveryLocations` to resolve city/zone/area names. While this is a single additional query (not N+1), it could be included in the original batch:

```typescript
const [countArr, results, locations] = await db.batch([countQuery, resultsQuery, locationQuery]);
```

However, the location query depends on the result set. The current approach is acceptable for the typical page size (10-50 rows). This is a minor optimization opportunity, not a bug.

### 15. `getCustomerOrders()` uses a correlated subquery for product images

**File:** `packages/core/src/modules/customers/customers.service.ts` (lines 377-383)

```typescript
productImage: sql<string>`(
  SELECT ${productImages.url}
  FROM ${productImages}
  WHERE ${productImages.productId} = ${products.id}
  AND ${productImages.isPrimary} = 1
  LIMIT 1
)`.as("productImage"),
```

This executes a correlated subquery per order item row. For customers with many orders containing many items, this scales poorly. A LEFT JOIN on `productImages` with `isPrimary = 1` would be more efficient.

### 16. FTS5 search rebuilds not triggered after bulk operations

**File:** `packages/core/src/modules/customers/customers.service.ts` (`bulkDeleteCustomers` lines 303-310)

`bulkDeleteCustomers()` with `permanent = true` deletes customer rows directly. The FTS5 triggers fire per-row on `DELETE`, which is correct. However, for very large bulk deletes, this could be slow. This is acceptable for the current scale but worth noting.

---

## Robustness Gaps

### 17. `permanentlyDeleteCustomer()` does not verify customer exists first

**File:** `packages/core/src/modules/customers/customers.service.ts` (lines 294-297)

```typescript
export async function permanentlyDeleteCustomer(db: Database, id: string): Promise<void> {
    await db.delete(customerHistory).where(eq(customerHistory.customerId, id));
    await db.delete(customers).where(eq(customers.id, id));
}
```

Unlike `deleteCustomer()` which checks existence first, `permanentlyDeleteCustomer()` blindly issues two DELETE statements. This means the route handler returns 204 even for non-existent customers. While not a security issue, it violates REST semantics (should be 404 for non-existent resource).

**Fix:** Add existence check or use the same pattern as `deleteCustomer()`.

### 18. `restoreCustomer()` does not verify customer exists or is actually soft-deleted

**File:** `packages/core/src/modules/customers/customers.service.ts` (lines 299-301)

```typescript
export async function restoreCustomer(db: Database, id: string): Promise<void> {
    await db.update(customers).set({ deletedAt: null }).where(eq(customers.id, id));
}
```

No existence check and no check that `deletedAt` is actually non-null. Restoring a non-deleted customer is a no-op but the route returns 204, which is misleading.

### 19. OTP verification race condition between attempt check and increment

**File:** `packages/core/src/modules/customers/customer-auth.service.ts` (lines 298-313)

The attempt counter is read, incremented in memory, checked against max, and then written back:

```typescript
stored.attempts++;
if (stored.attempts > 5) {
  await kv.delete(otpKey);
  throw new RateLimitError(...);
}
// verify code...
await kv.put(otpKey, JSON.stringify(stored), { ... });
```

If multiple concurrent requests arrive with incorrect codes, they all read the same `attempts` value before any writes back, allowing more than 5 attempts. In practice, Cloudflare Workers run single-threaded per request, but KV is eventually consistent -- two concurrent requests to different edge locations could both read `attempts: 4` and both allow the attempt.

**Impact:** Low in practice (OTP brute-force still requires knowing the 6-digit code). Mitigation would require KV compare-and-swap or Durable Objects.

### 20. `verifyOtp()` swallows DB errors as non-critical

**File:** `packages/core/src/modules/customers/customer-auth.service.ts` (lines 368-372)

```typescript
} catch (dbError: unknown) {
    if (dbError instanceof ValidationError) throw dbError;
    console.warn("[CustomerAuth] DB lookup/insert failed (non-critical):", dbError);
}
```

If the customer DB insert fails (e.g., D1 is down), the session is still created with `customerId` set. But the customer record does not exist in the DB. This creates an orphaned session that references a non-existent customer. When that session later calls `getCustomerOrders()`, it queries for orders by a `customerId` that has no customer record.

**Fix:** If the DB insert fails, either:
1. Do not set `customerId` on the session (treat as anonymous), or
2. Propagate the error and fail the verification (require retry)

### 21. `bulkDeleteCustomers()` has no limit on array size

**File:** `packages/core/src/modules/customers/customers.service.ts` (line 303)
**File:** `apps/api/src/routes/admin/customers.ts` (lines 98-113)

The route accepts any array of `customerIds` with no size limit:

```typescript
schema: z.object({
    customerIds: z.array(z.string()),
    permanent: z.boolean().default(false)
})
```

A malicious or buggy admin client could send thousands of IDs. SQLite's `IN (...)` clause has practical limits around 999 bindings.

**Fix:** Add `.max(100)` or similar to the `z.array()` validation.

---

## LLM-Friendliness

### 22. Excellent README documentation

**File:** `packages/core/src/modules/customers/README.md`

The README is 163 lines and covers every aspect: file inventory, features, flows, API endpoints, data flow diagrams, dependencies, schema details, and known gaps. This is a strong example for other domains to follow.

### 23. Good comment headers in service files

**Files:**
- `packages/core/src/modules/customers/customers.service.ts` -- section headers (`// Queries`, `// Mutations`)
- `packages/core/src/modules/customers/customer-auth.service.ts` -- section headers (`// Constants`, `// Types`, `// Utility functions`, `// Service functions`)
- `packages/core/src/modules/customers/otp-transport.ts` -- section headers and JSDoc on interface/classes

### 24. Route file lacks JSDoc on handler functions

**File:** `apps/api/src/routes/customer-auth.ts`

The route handlers for `/profile`, `/orders`, and `/me` contain non-obvious business logic (session merging, profile update propagation to KV) but have no inline comments explaining the "why." Compare this with `customer-auth.service.ts` which has JSDoc on every exported function.

### 25. Type imports could be more explicit for LLM navigation

**File:** `apps/admin/src/components/admin/CustomerForm.tsx`

The form component imports `unwrapEnvelope` and `extractApiError` from `@/lib/api-helpers` but does not import any domain types from the SDK or core package. An LLM navigating this file cannot easily determine the shape of the API response without tracing through multiple files.

---

## Recommended Changes

### Priority 1 -- Fix Bugs & Correctness

| # | Issue | File(s) | Effort |
|---|-------|---------|--------|
| 1 | Wrap mutations + history in `db.batch()` | `packages/core/src/modules/customers/customers.service.ts` | Small |
| 2 | Change `updateCustomer()` return from `{ success: true }` to void | `packages/core/src/modules/customers/customers.service.ts` | Trivial |
| 4 | Replace `Object.assign(new Error)` with typed error classes | `packages/core/src/modules/customers/customers.service.ts` | Small |
| 20 | Fix `verifyOtp()` DB error handling to not create orphaned sessions | `packages/core/src/modules/customers/customer-auth.service.ts` | Small |
| 21 | Add `.max()` limit to `customerIds` array in bulk delete | `apps/api/src/routes/admin/customers.ts` | Trivial |

### Priority 2 -- Improve Consistency

| # | Issue | File(s) | Effort |
|---|-------|---------|--------|
| 3 | Rename `StoredOtp.email` to `StoredOtp.identifier` | `packages/core/src/modules/customers/customer-auth.service.ts` | Trivial |
| 5 | Remove `as any` cast on createCustomer route handler | `apps/api/src/routes/admin/customers.ts` | Small |
| 6 | Extract history route logic to service layer | `apps/api/src/routes/admin/customers.ts` -> `customers.service.ts` | Medium |
| 8 | Remove dead `if (!result.success)` code in sendOtp/verifyOtp handlers | `apps/api/src/routes/customer-auth.ts` | Trivial |
| 9 | Import canonical validation schema in CustomerForm | `apps/admin/src/components/admin/CustomerForm.tsx` | Small |
| 17 | Add existence check to `permanentlyDeleteCustomer()` | `packages/core/src/modules/customers/customers.service.ts` | Trivial |
| 18 | Add existence + soft-delete check to `restoreCustomer()` | `packages/core/src/modules/customers/customers.service.ts` | Trivial |

### Priority 3 -- Improve Maintainability

| # | Issue | File(s) | Effort |
|---|-------|---------|--------|
| 7 | Deduplicate `Customer` type across admin UI files | `apps/admin/src/components/admin/` | Small |
| 10 | Extract shared `resolveLocationNames()` utility | `packages/core/src/modules/customers/customers.service.ts` | Medium |
| 11 | Split `CustomerHistoryView.tsx` into sub-components | `apps/admin/src/components/admin/CustomerHistoryView.tsx` | Medium |
| 13 | Add pagination to `getCustomerOrders()` | `packages/core/src/modules/customers/customers.service.ts` | Small |

### Priority 4 -- Nice to Have

| # | Issue | File(s) | Effort |
|---|-------|---------|--------|
| 12 | Add customer-auth exports to barrel `index.ts` | `packages/core/src/modules/customers/index.ts` | Trivial |
| 15 | Replace correlated subquery with JOIN for product images | `packages/core/src/modules/customers/customers.service.ts` | Small |
| 19 | Document OTP race condition and accept risk | `packages/core/src/modules/customers/README.md` | Trivial |

### Not Recommended (Acceptable as-is)

- **Issue 14** (location enrichment after batch): Acceptable pattern for current page sizes
- **Issue 16** (FTS5 and bulk deletes): SQLite triggers handle this correctly
- **Issue 24** (route JSDoc): Nice to have but the README compensates
