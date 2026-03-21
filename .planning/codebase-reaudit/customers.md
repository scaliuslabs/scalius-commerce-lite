# Customers Domain Re-Audit

**Analysis Date:** 2026-03-21
**Previous Audit:** 2026-03-20

## Quality Score: 7.5/10 (up from ~6.5)

The fix session addressed the highest-impact correctness issue (non-atomic writes) and improved the `updateCustomer()` return value. However, a significant number of the original 25 findings remain open, particularly around error handling patterns, dead code, duplicate types, and the large inline history route. The domain is functionally solid but has accumulated consistency debt relative to the conventions documented in CLAUDE.md.

---

## Previous Findings Status

| # | Issue | Status | Notes |
|---|-------|--------|-------|
| 1 | Non-atomic customer + history writes | **FIXED** | `createCustomer()` (line 167), `updateCustomer()` (line 249), and `deleteCustomer()` (line 276) in `packages/core/src/modules/customers/customers.service.ts` all use `db.batch([...])` now. However, each batch call uses `as any` type cast (lines 201, 267, 294) to work around Drizzle batch typing. |
| 2 | `updateCustomer()` returns `{ success: true }` | **FIXED** | `updateCustomer()` at line 269 of `packages/core/src/modules/customers/customers.service.ts` now returns void (no return statement after the batch). The route handler at line 162 of `apps/api/src/routes/admin/customers.ts` returns `ok(c, {})` correctly. |
| 3 | `StoredOtp.email` field misleading for phone OTP | **STILL OPEN** | `packages/core/src/modules/customers/customer-auth.service.ts` line 44 still uses `email: string` in the `StoredOtp` interface. Line 233 sets `email: normalizedIdentifier` even for phone-based OTP. |
| 4 | Error throwing uses `Object.assign(new Error)` instead of typed classes | **STILL OPEN** | `packages/core/src/modules/customers/customers.service.ts` lines 150, 216, 224, 274 all still use `Object.assign(new Error(...), { statusCode })`. Meanwhile `customer-auth.service.ts` correctly uses typed error classes from `@scalius/core/errors`. |
| 5 | Route handler uses `as any` on createCustomer handler | **STILL OPEN** | `apps/api/src/routes/admin/customers.ts` line 79 still has `(async (c: any) => { ... }) as any` on the create handler. Additionally, `apps/api/src/routes/customer-auth.ts` line 405 has the same pattern on the getCustomerOrders handler. |
| 6 | History route has ~100 lines of inline business logic | **STILL OPEN** | `apps/api/src/routes/admin/customers.ts` lines 247-353 still contain the entire history endpoint inline: batch queries, location enrichment, date formatting, data transformation. Not delegated to service layer. |
| 7 | Duplicate `Customer` type definitions across admin UI | **STILL OPEN** | `apps/admin/src/components/admin/customer-list/hooks/useCustomerListState.ts` lines 3-21 and `apps/admin/src/components/admin/CustomerHistoryView.tsx` lines 46-64 both define nearly identical `Customer` interfaces. Neither imports from `@scalius/api-client/types`. |
| 8 | Dead `if (!result.success)` code in sendOtp/verifyOtp handlers | **STILL OPEN** | `apps/api/src/routes/customer-auth.ts` lines 86-95 (sendOtp) and lines 177-186 (verifyOtp) still contain dead code branches. Both `sendOtp()` and `verifyOtp()` in the service layer throw typed errors on failure and always return `{ success: true, ... }` on the happy path. These branches are unreachable. |
| 9 | `CustomerForm.tsx` re-defines its own Zod schema | **STILL OPEN** | `apps/admin/src/components/admin/CustomerForm.tsx` lines 31-52 define a local `customerFormSchema` with basic `z.string().min(7).max(16)` phone validation instead of importing `phoneNumberSchema` from `@scalius/core/modules/customers/customers.validation`. |
| 10 | Location name enrichment duplicated in 4 places | **STILL OPEN** | Still duplicated in `customers.service.ts` (`listCustomers` lines 110-128, `createCustomer` lines 152-164, `updateCustomer` lines 227-239) and `apps/api/src/routes/admin/customers.ts` (history route lines 304-323). |
| 11 | `CustomerHistoryView.tsx` is a 639-line monolith | **STILL OPEN** | File remains at 639 lines. Still contains: interfaces, helper functions (`formatDate`, `getInitials`, `getStatusBadgeVariant`, `getStatusIcon`, `getChangeTypeBadgeVariant`), profile card, orders table, and change history timeline all in one file. |
| 12 | `index.ts` barrel only exports admin service | **STILL OPEN** | `packages/core/src/modules/customers/index.ts` line 2: `export * from "./customers.service"` only. `customer-auth.service.ts` must be imported by full path. |
| 13 | `getCustomerOrders()` hardcodes `.limit(50)` | **STILL OPEN** | `packages/core/src/modules/customers/customers.service.ts` line 364: `.limit(50)` with no pagination parameters. |
| 14 | Location enrichment query after batch (minor) | **STILL OPEN (Acceptable)** | Unchanged. Acceptable for current page sizes. |
| 15 | Correlated subquery for product images | **STILL OPEN** | `packages/core/src/modules/customers/customers.service.ts` lines 380-386 still use a correlated subquery for product images instead of a LEFT JOIN. |
| 16 | FTS5 rebuild on bulk deletes (minor) | **STILL OPEN (Acceptable)** | Unchanged. SQLite triggers handle this correctly. |
| 17 | `permanentlyDeleteCustomer()` no existence check | **STILL OPEN** | `packages/core/src/modules/customers/customers.service.ts` lines 297-300 still blindly issue DELETE statements without checking if the customer exists first. Route returns 204 for non-existent IDs. |
| 18 | `restoreCustomer()` no existence/state check | **STILL OPEN** | `packages/core/src/modules/customers/customers.service.ts` lines 302-304 still update without verifying the customer exists or is soft-deleted. |
| 19 | OTP race condition between attempt check and increment | **STILL OPEN (Acceptable)** | Unchanged. KV eventual consistency allows theoretical bypass of 5-attempt limit. Low practical impact. |
| 20 | `verifyOtp()` swallows DB errors as non-critical | **STILL OPEN** | `packages/core/src/modules/customers/customer-auth.service.ts` lines 368-372 still catch DB errors with `console.warn` and proceed to create the session. If the customer insert fails, an orphaned session referencing a non-existent customer is created. |
| 21 | `bulkDeleteCustomers()` no limit on array size | **STILL OPEN** | `apps/api/src/routes/admin/customers.ts` line 98: `customerIds: z.array(z.string())` still has no `.max()` constraint. |
| 22 | Excellent README documentation | **STILL POSITIVE** | README at `packages/core/src/modules/customers/README.md` is 163 lines, comprehensive, and documents known gaps. |
| 23 | Good comment headers in service files | **STILL POSITIVE** | Section headers remain well-organized. |
| 24 | Route file lacks JSDoc on handlers | **STILL OPEN (Low Priority)** | `apps/api/src/routes/customer-auth.ts` handlers still lack inline comments. |
| 25 | Type imports not explicit in CustomerForm | **STILL OPEN (Low Priority)** | `apps/admin/src/components/admin/CustomerForm.tsx` still does not import domain types from SDK. |

**Summary:** 2 of 21 issues fixed. 16 still open. 3 acceptable as-is. 2 positive observations unchanged.

---

## New Issues Found

### N1. `db.batch()` calls use `as any` type casts in service layer

**File:** `packages/core/src/modules/customers/customers.service.ts` (lines 201, 267, 294)

The fix for issue #1 (atomicity) introduced three `as any` casts on `db.batch([...])` calls. This suppresses Drizzle's batch return type checking. The pattern:

```typescript
await db.batch([
    db.insert(customers).values({ ... }),
    db.insert(customerHistory).values({ ... }),
] as any);
```

This is a known Drizzle ORM typing limitation where `db.batch()` with mixed query types (insert into different tables) does not infer correctly. The casts are localized and the actual runtime behavior is correct. However, they should be noted as tech debt.

**Impact:** Low -- runtime correct, type safety bypassed locally.
**Fix approach:** Wait for Drizzle to improve batch typing, or define a typed wrapper function.

### N2. `getCustomerOrders` handler in `customer-auth.ts` also uses `as any` cast

**File:** `apps/api/src/routes/customer-auth.ts` (line 405)

```typescript
app.openapi(getCustomerOrdersRoute, (async (c: any) => {
```

The `/orders` handler for customer auth has the same `as any` cast pattern as the admin create handler. This is a second route handler with suppressed type safety.

**Impact:** Low -- same workaround as issue #5.

### N3. `permanentlyDeleteCustomer` is not atomic

**File:** `packages/core/src/modules/customers/customers.service.ts` (lines 297-300)

While the fix for issue #1 made create/update/delete atomic with `db.batch()`, `permanentlyDeleteCustomer()` still uses two separate `await` calls:

```typescript
await db.delete(customerHistory).where(eq(customerHistory.customerId, id));
await db.delete(customers).where(eq(customers.id, id));
```

If the second DELETE fails, history records are deleted but the customer remains. This is the same class of bug that issue #1 originally flagged.

**Impact:** Medium -- data inconsistency risk during permanent deletion.
**Fix approach:** Wrap in `db.batch([...])` like the other mutations.

### N4. `bulkDeleteCustomers` soft-delete path writes no history records

**File:** `packages/core/src/modules/customers/customers.service.ts` (lines 306-313)

The single-customer `deleteCustomer()` correctly writes a history record with `changeType: "deleted"`. But `bulkDeleteCustomers()` in soft-delete mode (line 311) just sets `deletedAt` without writing any history records:

```typescript
await db.update(customers).set({ deletedAt: sql`unixepoch()` }).where(inArray(customers.id, ids));
```

This breaks the audit trail for bulk soft-deletes.

**Impact:** Medium -- audit trail gap for bulk operations.
**Fix approach:** Generate history records for each customer in the bulk set, using `db.batch()`.

### N5. `SendOtpResult` and `VerifyOtpResult` interfaces contain dead fields

**File:** `packages/core/src/modules/customers/customer-auth.service.ts` (lines 56-64, 74-88)

Both result interfaces define `error`, `httpStatus`, and `attemptsLeft` fields that are never populated in the current implementation. After the refactor to throw typed errors, the service always returns `{ success: true, ... }` on the happy path. These fields are vestigial from the pre-refactor error-return pattern.

The dead fields directly cause the dead code in issue #8 (route handlers checking `result.success`).

**Impact:** Low -- misleading interfaces, no runtime effect.
**Fix approach:** Remove `error`, `httpStatus`, `attemptsLeft` from result interfaces. Change `success` to always-true literal type `true`, or remove it entirely and return the payload directly.

### N6. `updateCustomerProfile()` DB update does not check affected rows

**File:** `packages/core/src/modules/customers/customer-auth.service.ts` (lines 448-463)

When updating a customer profile, the function does not verify that the DB update actually modified a row. If `session.customerId` references a deleted or non-existent customer, the update silently does nothing but the session is still updated in KV:

```typescript
if (session.customerId) {
    await db.update(customers).set(dbUpdates).where(eq(customers.id, session.customerId));
}
```

**Impact:** Low -- stale session data would not match DB state after customer deletion.

---

## Remaining Debt Summary

### High Priority (Correctness)

| # | Issue | File | Effort |
|---|-------|------|--------|
| 4 | Replace `Object.assign(new Error)` with typed error classes | `packages/core/src/modules/customers/customers.service.ts` | Small |
| 8 | Remove dead `if (!result.success)` branches | `apps/api/src/routes/customer-auth.ts` | Trivial |
| 20 | Fix orphaned session on DB error in `verifyOtp()` | `packages/core/src/modules/customers/customer-auth.service.ts` | Small |
| N3 | Make `permanentlyDeleteCustomer()` atomic via `db.batch()` | `packages/core/src/modules/customers/customers.service.ts` | Trivial |
| N4 | Add history records for bulk soft-delete | `packages/core/src/modules/customers/customers.service.ts` | Small |

### Medium Priority (Consistency)

| # | Issue | File | Effort |
|---|-------|------|--------|
| 3 | Rename `StoredOtp.email` to `identifier` | `packages/core/src/modules/customers/customer-auth.service.ts` | Trivial |
| 5 | Remove `as any` on route handlers | `apps/api/src/routes/admin/customers.ts`, `customer-auth.ts` | Small |
| 6 | Extract history route logic to service | `apps/api/src/routes/admin/customers.ts` | Medium |
| 9 | Import canonical validation in CustomerForm | `apps/admin/src/components/admin/CustomerForm.tsx` | Small |
| 17 | Add existence check to `permanentlyDeleteCustomer()` | `packages/core/src/modules/customers/customers.service.ts` | Trivial |
| 18 | Add existence + state check to `restoreCustomer()` | `packages/core/src/modules/customers/customers.service.ts` | Trivial |
| 21 | Add `.max(100)` to bulk delete array | `apps/api/src/routes/admin/customers.ts` | Trivial |
| N5 | Remove dead fields from result interfaces | `packages/core/src/modules/customers/customer-auth.service.ts` | Trivial |

### Low Priority (Maintainability)

| # | Issue | File | Effort |
|---|-------|------|--------|
| 7 | Deduplicate `Customer` type across admin UI | `customer-list/hooks/useCustomerListState.ts`, `CustomerHistoryView.tsx` | Small |
| 10 | Extract shared `resolveLocationNames()` | `packages/core/src/modules/customers/customers.service.ts` | Medium |
| 11 | Split `CustomerHistoryView.tsx` (639 lines) | `apps/admin/src/components/admin/CustomerHistoryView.tsx` | Medium |
| 13 | Add pagination to `getCustomerOrders()` | `packages/core/src/modules/customers/customers.service.ts` | Small |
| 12 | Add customer-auth to barrel exports | `packages/core/src/modules/customers/index.ts` | Trivial |
| 15 | Replace correlated subquery with JOIN | `packages/core/src/modules/customers/customers.service.ts` | Small |
| N1 | `db.batch()` `as any` casts (Drizzle limitation) | `packages/core/src/modules/customers/customers.service.ts` | Deferred |

---

## Scores

| Dimension | Score | Notes |
|-----------|-------|-------|
| Correctness | 7/10 | Atomic writes fixed for main mutations; `permanentlyDeleteCustomer` still non-atomic; error throwing inconsistent; orphaned session risk remains |
| Consistency | 6/10 | Mixed error patterns (typed classes in auth vs `Object.assign` in admin); dead code branches in route; `as any` casts in 5 locations |
| Maintainability | 7/10 | Good file organization; README is excellent; but 639-line monolith, 4x duplicated location enrichment, duplicate types remain |
| Performance | 8/10 | Batch queries used effectively; correlated subquery is a minor concern; hardcoded limit(50) acceptable for now |
| Security | 8/10 | E.164 normalization correct; OTP properly deleted after verification; rate limiting in place; race condition is low-risk |
| Robustness | 7/10 | No existence checks on permanent delete/restore; DB error swallowing in verifyOtp; no bulk array size limit |
| LLM-Friendliness | 8/10 | Excellent README; good section headers; duplicate types hinder navigation; route handlers lack JSDoc |
| **Overall** | **7.5/10** | Improved from ~6.5 after atomic write fix. Main remaining gaps: error pattern inconsistency, dead code, and inline business logic in route. |

---

*Re-audit: 2026-03-21. Previous audit: 2026-03-20. 2 of 21 issues fixed, 6 new issues identified.*
