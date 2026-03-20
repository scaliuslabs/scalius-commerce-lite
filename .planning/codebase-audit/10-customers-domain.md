# Customers Domain Audit

## Scope

Customer management: CRUD, auth (OTP), session management, order history, admin components, storefront auth, phone normalization.

## Files Reviewed

| File | Purpose |
|------|---------|
| `packages/core/src/modules/customers/customers.service.ts` | Admin CRUD + storefront order history |
| `packages/core/src/modules/customers/customers.validation.ts` | Zod schemas for create/update |
| `packages/core/src/modules/customers/customer-auth.service.ts` | OTP generation/verification, session management |
| `packages/core/src/modules/customers/otp-transport.ts` | Transport abstraction (email, SMS, WhatsApp) |
| `packages/core/src/modules/customers/index.ts` | Barrel export (customers.service only) |
| `apps/api/src/routes/admin/customers.ts` | Admin API routes (OpenAPIHono) |
| `apps/api/src/routes/customer-auth.ts` | Storefront auth routes |
| `packages/database/src/schema/customers.ts` | Drizzle schema for customers + customerHistory |
| `apps/admin/src/components/admin/customer-list/*` | List container, table, delete dialog, hooks |
| `apps/admin/src/components/admin/CustomerForm.tsx` | Create/edit form |
| `apps/admin/src/components/admin/CustomerHistoryView.tsx` | Customer detail + history timeline |
| `apps/admin/src/loaders/admin/customers.ts` | SSR data loaders |
| `apps/storefront/src/lib/api/customer-auth.ts` | Client-side auth API wrapper |
| `apps/storefront/src/components/AuthModal.tsx` | Login/signup modal |
| `apps/storefront/src/pages/api/customer-auth/[...path].ts` | Same-origin auth proxy |
| `apps/storefront/src/pages/api/auth/logout.ts` | Same-origin logout proxy |
| `packages/shared/src/customer-utils.ts` | Phone normalization, validation, stats |

---

## 1. Customer CRUD

**Rating: Good**

Full lifecycle is implemented: create, read (by ID + list with pagination), update, soft-delete, permanent-delete, restore, bulk-delete.

Strengths:
- `listCustomers()` uses `db.batch()` for count + results in a single roundtrip.
- Unique phone constraint enforced at both DB (`customer_phone_unique`) and application level (duplicate check in create/update).
- All mutations record a `customerHistory` entry for audit trail.
- Location name enrichment (city/zone/area IDs resolved to human names) on both list and detail.
- FTS5 search for customer lookup.
- Soft-delete pattern with trash/restore is clean and consistent.

### Issues

**[P2] `permanentlyDeleteCustomer` does not check for existing orders.** Permanently deleting a customer with orders would leave orphaned `orders.customerId` references (orders table has a `customerId` FK). This could cascade-delete orders if the FK is set to CASCADE, or fail silently if it is not. Either way, the business logic should guard against this.

```
// customers.service.ts:294
export async function permanentlyDeleteCustomer(db: Database, id: string): Promise<void> {
    await db.delete(customerHistory).where(eq(customerHistory.customerId, id));
    await db.delete(customers).where(eq(customers.id, id));
    // No order check!
}
```

**[P3] `bulkDeleteCustomers` (soft-delete path) does not record `customerHistory` entries.** Single soft-delete records a history entry; bulk does not. Inconsistent audit trail.

**[P3] `restoreCustomer` does not record a history entry or update `updatedAt`.** The customer is restored but no audit trace is left and the timestamp is stale.

**[P3] `createCustomer` uses non-standard error pattern.** Service throws `Object.assign(new Error(...), { statusCode })` instead of the project's `ApiError`/`ValidationError` classes. The route handler catches and re-wraps, but this is fragile.

---

## 2. Customer Auth (OTP)

**Rating: Good**

Well-structured OTP flow: generate code -> store in KV with TTL -> queue delivery -> verify -> create/find customer -> create KV session -> set HttpOnly cookie.

Strengths:
- OTP codes generated with `crypto.getRandomValues()` -- cryptographically secure.
- 6-digit numeric codes, 5-minute TTL, max 5 verification attempts.
- IP-based rate limiting (5 requests/10min) via KV.
- Per-identifier cooldown (2-minute minimum between sends).
- Transport abstraction (email, SMS, WhatsApp) with strategy pattern.
- OTP delivery is async via queue (no inline sending that could block the request).
- OTP code is NOT logged in production.
- Session stored in KV with 30-day TTL; cookie is HttpOnly + Secure + SameSite.
- Same-origin proxy in storefront ensures cookies work cross-domain.
- Logout clears both host-only and domain-scoped cookies.

### Issues

**[P2] `StoredOtp.email` field is misleadingly named.** When method is "phone", the `email` field stores the phone number (normalized E.164). This is confusing and could lead to bugs if someone reads the field literally.

```typescript
// customer-auth.service.ts:44
export interface StoredOtp {
    code: string;
    email: string;    // Actually stores the normalized identifier (email OR phone)
    expiresAt: number;
    attempts: number;
}
```

**[P2] `updateCustomerProfile` uses `new Date()` instead of `sql\`unixepoch()\``.** The schema uses integer timestamps (`mode: "timestamp"`). Writing `new Date()` may produce a JavaScript Date object where Drizzle expects a Unix timestamp, causing a type mismatch or incorrect value in D1.

```typescript
// customer-auth.service.ts:450
const dbUpdates: Record<string, unknown> = {
    updatedAt: new Date(),  // Should be sql`unixepoch()` like all other mutations
};
```

**[P3] `verifyOtp` creates customer with plain `nanoid()` instead of prefixed `cust_` ID.** Admin CRUD uses `"cust_" + nanoid()` but storefront signup uses bare `nanoid()`. Inconsistent ID format makes it harder to identify record origins.

```typescript
// customer-auth.service.ts:349
customerId = nanoid();  // Should be "cust_" + nanoid() to match admin creation
```

**[P3] Dead code path in route handler.** After `sendOtp()` was refactored to throw errors instead of returning `{ success: false }`, the `if (!result.success)` block in the route handler (customer-auth.ts:84-93) is unreachable. Not harmful but misleading.

**[P3] Session does not store `area` or `address` fields.** The `CustomerSession` interface only has `name`, `email`, `phone`, `customerId`. Address and location data are fetched from DB when needed. This means the `/me` endpoint returns incomplete profile data -- consumers must make separate calls.

---

## 3. Phone Normalization

**Rating: Very Good**

Consistent E.164 normalization throughout the stack, using `libphonenumber-js`.

Strengths:
- `phoneNumberSchema` in validation transforms to E.164 on input (admin CRUD).
- `sendOtp()` and `verifyOtp()` normalize identifiers to E.164 before KV storage/lookup.
- `formatPhoneForDisplay()` converts back to international format for UI.
- `formatPhoneForProvider()` converts to national format for delivery APIs.
- Admin form uses `react-phone-number-input` with configurable country lists.
- Storefront AuthModal uses the same phone input component.

### Issues

**[P3] `CustomerForm.tsx` phone validation is weaker than the backend.** The form schema uses `z.string().min(7).max(16)` while the backend uses `phoneNumberSchema` (which validates via `libphonenumber-js` and transforms to E.164). A user could enter `1234567` in the form and get a backend 400. Consider importing `phoneNumberSchema` in the client-side form, or at minimum matching the regex pattern.

---

## 4. Order History

**Rating: Good**

`getCustomerOrders()` provides a rich order history view for authenticated customers.

Strengths:
- Batch-loads all order items in a single query with `IN` clause (avoids N+1).
- Joins products and variants for item details including images.
- Returns customer profile alongside orders.
- Admin history route (`GET /{id}/history`) uses `db.batch()` for customer + history + orders in parallel.
- Hard limit of 50 orders prevents unbounded queries.

### Issues

**[P3] No pagination on storefront order history.** `getCustomerOrders()` has a hard `.limit(50)` with no page/offset parameters. Customers with 50+ orders will silently lose older ones. The admin history view also has no pagination (loads all, shows in 5-item chunks client-side).

**[P3] `getCustomerOrders` does not return `areaName`.** The `orders` select includes `cityName` and `zoneName` but not `areaName`. The storefront `CustomerOrder` type interface includes `areaName` as nullable but the query never selects it, so it will always be undefined.

---

## 5. Admin vs Storefront Boundaries

**Rating: Very Good**

Clean separation between admin and storefront data access.

Strengths:
- Admin routes are under `/api/v1/admin/customers` and require admin auth middleware.
- Storefront routes are under `/api/v1/customer-auth` and use cookie-based customer sessions.
- Storefront cannot access admin CRUD operations.
- The `index.ts` barrel only exports `customers.service.ts` (admin CRUD). `customer-auth.service.ts` is imported by explicit path, enforcing the boundary.
- Storefront proxy rewrites cookies (strips Domain, changes SameSite) correctly.
- Logout proxy has both same-origin and domain-scoped cookie clearing.

### Issues

**[P3] Storefront `/me` endpoint returns `customerId`.** While needed for order matching, exposing internal IDs to the client could be an information disclosure concern in some threat models. Consider whether the storefront truly needs this in the response.

---

## 6. Validation

**Rating: Good**

Zod schemas are concise and consistent between create/update (partial pattern).

Strengths:
- `createCustomerSchema` covers all required fields with appropriate constraints (min/max length).
- `updateCustomerSchema` is `createCustomerSchema.partial()` -- elegant and guarantees consistency.
- Phone validation uses the shared `phoneNumberSchema` which validates AND transforms to E.164.
- Email uses `z.email()` (Zod built-in).
- API routes use OpenAPIHono with schemas for request validation + OpenAPI spec generation.
- `verify-otp` route has `superRefine` for cross-field phone validation.

### Issues

**[P2] Admin route `sort` and `order` query params accept any string.** The list route validates `sort` as `z.string().optional()` but then casts it to the union type with `as`. An attacker could pass `sort=deletedAt` or `sort=password` and potentially cause unexpected behavior or SQL errors.

```typescript
// admin/customers.ts:54
sort: q.sort as "name" | "totalOrders" | "totalSpent" | ... | undefined,
```

Should be `z.enum(["name", "totalOrders", "totalSpent", "lastOrderAt", "createdAt", "updatedAt"]).optional()`.

**[P3] `updateCustomerProfile` (storefront auth) has no Zod validation in the service layer.** The route validates with a basic schema, but the service accepts `Record<string, string | undefined>` -- no constraints on field lengths or content. An attacker could pass extremely long strings or inject unexpected field names.

---

## 7. Privacy & PII

**Rating: Good**

Reasonable handling of sensitive customer data.

Strengths:
- Session cookie is HttpOnly (not accessible to JavaScript).
- OTP codes are not logged.
- Customer auth sessions are stored in KV (not in client-visible storage).
- Passwords are not used -- OTP-only auth eliminates password storage risks.
- Phone numbers are normalized to E.164 (canonical format) for storage.

### Issues

**[P3] `getCustomerById` returns all columns including `deletedAt`.** When used by the admin GET endpoint, this leaks the full raw record. Consider selecting specific columns for different consumers.

**[P3] Customer email addresses are visible in the customer list without any masking.** For admin users this is expected, but if admin accounts are compromised, full PII is exposed. Consider adding audit logging for customer data access.

---

## 8. LLM-Friendliness & Code Organization

**Rating: Very Good**

Strengths:
- Clear file separation: `customers.service.ts` (CRUD), `customer-auth.service.ts` (auth), `otp-transport.ts` (delivery), `customers.validation.ts` (schemas).
- Each file has a header comment explaining its purpose.
- The transport pattern (strategy) for OTP delivery is extensible.
- Types are co-located with the code that uses them.
- The `index.ts` barrel intentionally only exports CRUD -- auth is imported by path.
- Admin components follow the established `*-list/`, `*Form.tsx`, `*HistoryView.tsx` pattern.
- Hooks are cleanly split: `useCustomerListState` (pure state) vs `useCustomerListActions` (side effects).
- README exists in the module directory documenting the architecture.

### Issues

**[P4] `customer-auth.service.ts` is 483 lines and handles both OTP logic AND session management AND profile updates.** Could be split into `otp.service.ts` and `session.service.ts` for better separation, but this is a low-priority refactor.

---

## 9. Summary of Issues

### P2 (Should Fix)

| # | Issue | File | Description |
|---|-------|------|-------------|
| 1 | Orphan-unsafe permanent delete | `customers.service.ts:294` | `permanentlyDeleteCustomer` does not check for existing orders before deleting |
| 2 | Misleading `StoredOtp.email` field | `customer-auth.service.ts:44` | Field named `email` stores either email or phone number |
| 3 | `new Date()` vs `sql\`unixepoch()\`` | `customer-auth.service.ts:450` | Profile update uses JS Date object instead of SQL function for timestamp |
| 4 | Unvalidated sort/order params | `admin/customers.ts:37-38` | `sort` and `order` accept any string, cast with `as` |

### P3 (Minor / Improvement)

| # | Issue | File | Description |
|---|-------|------|-------------|
| 5 | Bulk soft-delete skips history | `customers.service.ts:303` | No `customerHistory` entries created for bulk operations |
| 6 | Restore skips history + `updatedAt` | `customers.service.ts:299` | No audit entry or timestamp update on restore |
| 7 | Non-standard error pattern in service | `customers.service.ts:150` | Uses `Object.assign(new Error(...), { statusCode })` instead of typed error classes |
| 8 | Inconsistent customer ID format | `customer-auth.service.ts:349` | Storefront signup uses `nanoid()`, admin uses `"cust_" + nanoid()` |
| 9 | Dead `!result.success` check | `customer-auth.ts:84` | Unreachable after sendOtp was refactored to throw |
| 10 | No pagination on storefront orders | `customers.service.ts:361` | Hard limit 50, no offset param |
| 11 | Missing `areaName` in storefront orders | `customers.service.ts:341` | Query does not select `areaName` despite type expecting it |
| 12 | Weak client-side phone validation | `CustomerForm.tsx:39` | Form uses min/max length while backend uses `libphonenumber-js` |
| 13 | No length validation on profile update | `customer-auth.service.ts:446` | Accepts `Record<string, string \| undefined>` with no constraints |
| 14 | `customerId` exposed to storefront client | `customer-auth.ts:220` | Internal ID visible in `/me` response |

### P4 (Nit)

| # | Issue | File | Description |
|---|-------|------|-------------|
| 15 | Large single file | `customer-auth.service.ts` | 483 lines handling OTP + session + profile -- could split |

---

## 10. Recommendations

### Quick Wins (< 30 min each)

1. **Add order check to `permanentlyDeleteCustomer`**: Query `orders` table before deleting; throw if orders exist.
2. **Fix `updatedAt` in profile update**: Change `new Date()` to `sql\`unixepoch()\`` in `updateCustomerProfile`.
3. **Prefix customer ID**: Change `nanoid()` to `"cust_" + nanoid()` in `verifyOtp` customer creation.
4. **Validate sort param**: Change `z.string().optional()` to `z.enum([...]).optional()` in the list route.
5. **Rename `StoredOtp.email`**: Rename to `identifier` to reflect its actual purpose.

### Medium Effort

6. **Add history entries for restore and bulk operations**: Record audit trail consistently for all state changes.
7. **Add storefront order pagination**: Accept `page`/`limit` params in `getCustomerOrders`.
8. **Use typed error classes in service layer**: Replace `Object.assign(new Error(...), { statusCode })` with `ValidationError`/`NotFoundError` from the errors module.

### Architecture

9. **Consider splitting `customer-auth.service.ts`** into OTP logic and session management if it grows further.
10. **Evaluate whether `customerId` needs to be in the storefront `/me` response**: Could use an opaque session reference instead.
