# Customers

Customer management (admin CRUD) and OTP-based storefront authentication with pluggable transports.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel export -- re-exports `customers.service` only (not customer-auth) |
| `customers.service.ts` | Admin CRUD: `listCustomers`, `createCustomer`, `updateCustomer`, `deleteCustomer`, `permanentDeleteCustomer`, `restoreCustomer`, `bulkDeleteCustomers`, `getCustomerById`. Also defines `createCustomerSchema`/`updateCustomerSchema` inline (duplicated from `customers.validation.ts`) |
| `customers.validation.ts` | Standalone Zod schemas for create/update -- `createCustomerSchema`, `updateCustomerSchema`. Identical to the schemas defined inline in `customers.service.ts` |
| `customer-auth.service.ts` | Storefront auth: `sendOtp()`, `verifyOtp()`, `getCustomerBySession()`, `deleteCustomerSession()`, `updateCustomerProfile()`. Cookie/session helpers. Imported directly by path (not through `index.ts`) |
| `otp-transport.ts` | `OtpTransport` interface + three implementations: `EmailOtpTransport`, `SmsOtpTransport`, `WhatsAppOtpTransport`. Factory: `getOtpTransport()` |

## Features

### Admin CRUD (`customers.service.ts`)

- **List** with pagination, FTS5 full-text search (name/phone/email), multi-field sorting, soft-delete filtering (active vs trashed)
- **Create** with phone uniqueness check, delivery location name resolution (city/zone/area IDs to display names), auto history record (`changeType: "created"`)
- **Update** with phone uniqueness check (excluding self), location name re-resolution, auto history record (`changeType: "updated"`)
- **Soft delete** sets `deletedAt` timestamp; **restore** clears it
- **Permanent delete** cascades: deletes `customerHistory` records first, then the customer
- **Bulk delete** supports both soft and permanent modes

### Phone Normalization

Two distinct normalizations exist:

1. **`phoneNumberSchema`** (`@scalius/shared/customer-utils`): Zod transform that calls `standardizePhoneNumber()` -- strips to digits, removes `880` country code, ensures `01XXXXXXXXX` format (Bangladesh local). Used in admin CRUD validation.
2. **`normalizePhone()`** (`@scalius/shared/customer-utils`): Converts to E.164 format (`+8801XXXXXXXXX`). Used in `customer-auth.service.ts` before all KV and DB lookups.

These two normalizations produce different formats (`01...` vs `+880...`). Admin-created customers get local format; storefront-created customers (via OTP) get E.164. This is a known inconsistency -- lookups in `customer-auth.service.ts` always use E.164, so admin-created customers may not match during storefront login.

### Customer Stats Materialization

`totalOrders`, `totalSpent`, and `lastOrderAt` are denormalized columns on the `customers` table. They are NOT updated by this module -- they are materialized by the orders domain:

- **`orders.admin.ts`**: Recalculates stats via `calculateCustomerStats()` after order create/update, using `db.batch()` for atomicity
- **`orders.queue.ts`**: Increments stats inline (`totalOrders + 1`, `totalSpent + amount`) during queue-based order processing
- **`orders.storefront.ts`**: Reads stats during checkout for existing customer lookup

### Customer History Audit Log

Every create and update writes a snapshot to `customerHistory` with `changeType` of `"created"` or `"updated"`. Includes all fields at that point in time (name, email, phone, address, location IDs and resolved names). History is displayed in the admin UI as a timeline. Soft deletes do NOT create a history record (no `changeType: "deleted"` is written despite the enum supporting it).

### OTP Authentication (`customer-auth.service.ts`)

**Flow:**
1. `sendOtp()` -- validates identifier format, checks site settings for allowed auth method, enforces IP rate limiting (5 requests/10 min via KV), enforces per-identifier cooldown (2 min), generates 6-digit cryptographic OTP, stores in KV with 5-min TTL and 0 attempts counter, resolves transport via factory, validates transport config, returns queue payload
2. Queue consumer (in `apps/api/src/queue-consumer.ts`) delivers OTP via the selected transport (email, SMS, WhatsApp)
3. `verifyOtp()` -- validates code against KV, enforces max 5 attempts (increments counter in KV), on success: looks up or creates customer in DB, creates 30-day session in KV, returns session token

**Session management:**
- Cookie name: `cs_tok` (HttpOnly, Secure)
- Companion cookie: `cs_auth` (non-HttpOnly, for client-side auth state detection)
- Session prefix in KV: `cust_session:`
- Session TTL: 30 days
- `getCustomerBySession()` checks expiry, deletes expired sessions
- `updateCustomerProfile()` updates both DB and KV session (name, address, city, zone)

**Transport selection:**
- Site settings `authVerificationMethod` controls allowed methods
- `"email"` -> only email allowed
- `"phone"` or `"sms_otp"` -> only phone (SMS) allowed
- `"whatsapp_otp"` -> only phone (WhatsApp) allowed
- `"both"` -> email and phone allowed
- WhatsApp transport validates `whatsappAccessToken` and `whatsappPhoneNumberId` from site settings

**Auto-registration:**
- If `verifyOtp()` finds no existing customer, it creates one automatically
- Email-method registration requires a phone number (prevents phone-less records)
- Phone-method registration creates customer with phone only (no email)
- New customers get a bare-bones record (no address/location)

## API Endpoints

### Admin Routes (`/api/v1/admin/customers`)

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/` | `listCustomers` | Paginated list with search/sort/trash filter |
| POST | `/` | `createCustomer` | Create with phone uniqueness + history |
| POST | `/bulk-delete` | `bulkDeleteCustomers` | Bulk soft or permanent delete |
| GET | `/{id}` | `getCustomerById` | Single customer by ID |
| PUT | `/{id}` | `updateCustomer` | Update with phone uniqueness + history |
| DELETE | `/{id}` | `deleteCustomer` | Soft delete |
| DELETE | `/{id}/permanent` | `permanentDeleteCustomer` | Hard delete + cascade history |
| POST | `/{id}/restore` | `restoreCustomer` | Restore soft-deleted |
| GET | `/{id}/history` | (inline in route) | Customer + history records + orders (batched query) |

### Storefront Auth Routes (`/api/v1/customer-auth`)

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| POST | `/send-otp` | `sendOtp` | Generate OTP, queue for delivery |
| POST | `/verify-otp` | `verifyOtp` | Verify OTP, create session, set cookies |
| GET | `/me` | `getCustomerBySession` | Return session info or `{ authenticated: false }` |
| POST | `/logout` | `deleteCustomerSession` | Delete KV session, clear cookies |
| PUT | `/profile` | `updateCustomerProfile` | Update name/address/city/zone |
| GET | `/orders` | (inline in route) | Customer's orders with items, product names, images |

## Data Flow

### Admin CRUD
```
Astro page (SSR) -> loader (apiGet) -> admin proxy -> API worker -> customers.service -> D1
                                                                                      -> customerHistory (audit)
```

### Storefront Auth
```
Browser -> storefront same-origin proxy (/api/customer-auth/*) -> API worker (service binding) -> customer-auth.service -> KV (OTP/sessions) + D1 (customers)
```

The storefront proxy rewrites cookies (strips `Domain=`, changes `SameSite=None` to `Lax`) to ensure browser compatibility. A separate `/api/auth/logout` proxy handles logout with explicit cookie clearing.

### Customer Stats
```
Order create/update (orders domain) -> calculateCustomerStats() -> UPDATE customers SET totalOrders, totalSpent, lastOrderAt
```

## Dependencies

- `@scalius/database` -- `customers`, `customerHistory`, `deliveryLocations`, `siteSettings`, `orders` (the latter three accessed in route handlers, not the service)
- `@scalius/shared/customer-utils` -- `phoneNumberSchema`, `normalizePhone`, `calculateCustomerStats`
- `@scalius/core/errors` -- `ValidationError`, `ForbiddenError`, `RateLimitError`, `ServiceUnavailableError`
- `@scalius/core/search` -- `ftsMatch` for FTS5 search
- Cloudflare KV (`CACHE` binding) -- OTP storage, session storage, rate limiting

## DB Schema

**`customers`** table:
- `id` (PK, `cust_` prefix from admin, nanoid from auth), `name`, `email` (nullable, indexed), `phone` (unique, indexed)
- `address`, `city`, `zone`, `area` (location IDs), `cityName`, `zoneName`, `areaName` (denormalized display names)
- `totalOrders`, `totalSpent`, `lastOrderAt` (materialized by orders domain)
- `createdAt`, `updatedAt`, `deletedAt` (soft delete)

**`customerHistory`** table:
- `id` (PK, `hist_` prefix), `customerId` (FK, cascade delete)
- Snapshot fields: `name`, `email`, `phone`, `address`, `city`, `zone`, `area`, `cityName`, `zoneName`, `areaName`
- `changeType` enum: `"created"`, `"updated"`, `"deleted"`
- `createdAt`

**FTS5 index** (`customers_fts`):
- Content table: `customers`
- Indexed columns: `name`, `phone`, `email`
- Auto-maintained via SQLite triggers (insert/update/delete)

## Known Gaps

1. **Duplicate validation schemas**: `createCustomerSchema` is defined identically in both `customers.service.ts` (lines 16-24) and `customers.validation.ts` (lines 9-17). The service imports `phoneNumberSchema` from shared but defines its own schema rather than importing from `customers.validation.ts`.

2. **Phone format inconsistency**: Admin CRUD normalizes to local format (`01XXXXXXXXX`) via `phoneNumberSchema`. Auth service normalizes to E.164 (`+8801XXXXXXXXX`) via `normalizePhone()`. A customer created via admin and one created via storefront OTP will have different phone formats in the DB, potentially preventing storefront login for admin-created customers.

3. **Soft delete history gap**: The `changeType` enum includes `"deleted"` but no code path writes a `"deleted"` history record. `deleteCustomer()` only sets `deletedAt` without creating a history entry.

4. **History route not in service**: The `GET /{id}/history` endpoint contains significant business logic inline in the route handler (batch query for customer + history + orders, location enrichment) rather than delegating to the service layer.

5. **Index barrel omission**: `index.ts` only re-exports `customers.service`. `customer-auth.service.ts` and `otp-transport.ts` must be imported by direct path.

6. **SMS transport stub**: `SmsOtpTransport.validateConfig()` returns `null` (always valid) but the actual SMS delivery in the queue consumer is noted as pending. Selecting SMS will accept OTPs but delivery may not work.

7. **Profile update limitations**: `updateCustomerProfile()` (storefront) only syncs `name` back to the KV session. Address/city/zone/cityName/zoneName are updated in DB but not reflected in the session object.

8. **No email update for existing customers**: `verifyOtp()` fills in `resolvedEmail` from the existing customer record but never updates it if the customer authenticates with a new email address.
