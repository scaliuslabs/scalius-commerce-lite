# Customers

Customer management (admin CRUD) and OTP-based storefront authentication with pluggable transports.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel export -- re-exports `customers.service` only (not customer-auth) |
| `customers.service.ts` | Admin CRUD: `listCustomers`, `createCustomer`, `updateCustomer`, `deleteCustomer`, `permanentlyDeleteCustomer`, `restoreCustomer`, `bulkDeleteCustomers`, `getCustomerById`. Re-exports schemas from `customers.validation.ts`. |
| `customers.validation.ts` | Canonical Zod schemas: `createCustomerSchema` (uses `phoneNumberSchema` from `@scalius/shared/customer-utils`), `updateCustomerSchema` (partial). Imported by both service and API routes. |
| `customer-auth.service.ts` | Storefront auth: `sendOtp()`, `verifyOtp()`, `getCustomerBySession()`, `deleteCustomerSession()`, `updateCustomerProfile()`. Cookie/session helpers. Imported directly by path (not through `index.ts`) |
| `otp-transport.ts` | `OtpTransport` interface + three implementations: `EmailOtpTransport`, `SmsOtpTransport`, `WhatsAppOtpTransport`. Factory: `getOtpTransport()` |
| `otp-delivery-receipts.ts` | D1 receipt helper for OTP delivery claims, accepted/failed/skipped marks, recipient hashing/masking, and provider client references |

## Features

### Admin CRUD (`customers.service.ts`)

- **List** with pagination, FTS5 full-text search (name/phone/email), multi-field sorting, soft-delete filtering (active vs trashed)
- **Create** with phone uniqueness check, delivery location name resolution (city/zone/area IDs to display names), auto history record (`changeType: "created"`)
- **Update** with phone uniqueness check (excluding self), location name re-resolution, auto history record (`changeType: "updated"`)
- **Soft delete** sets `deletedAt` timestamp and writes a history record (`changeType: "deleted"`)
- **Restore** clears `deletedAt` (no history record)
- **Permanent delete** cascades: deletes `customerHistory` records first, then the customer
- **Bulk delete** supports both soft and permanent modes

### Phone Normalization

All phone numbers are validated and stored in **E.164 format** (e.g. `+8801712345678`, `+14155552671`) using `libphonenumber-js`.

- **`phoneNumberSchema`** (`@scalius/shared/customer-utils`): Zod transform that calls `validateAndFormatPhone()` -- validates via `libphonenumber-js` and returns E.164. Used in admin CRUD validation.
- **`validateAndFormatPhone()`** (`@scalius/shared/customer-utils`): Validates any phone input and returns E.164. Supports all international formats. Optionally restricts to allowed country codes. Used in `customer-auth.service.ts` before all KV and DB lookups.
- **`formatPhoneForDisplay()`** (`@scalius/shared/customer-utils`): Converts E.164 back to international display format (e.g. `+880 1712-345678`).

Both admin-created and storefront-created customers now use the same E.164 format, eliminating the previous format mismatch.

### Customer Stats Materialization

`totalOrders`, `totalSpent`, and `lastOrderAt` are denormalized columns on the `customers` table. They are NOT updated by this module -- they are materialized by the orders domain:

- **`orders.admin.ts`**: Recalculates stats via `calculateCustomerStats()` after order create/update, using `db.batch()` for atomicity
- **`orders.queue.ts`**: Increments stats inline (`totalOrders + 1`, `totalSpent + amount`) during queue-based order processing
- **`orders.storefront.ts`**: Reads stats during checkout for existing customer lookup

### Customer History Audit Log

Every create, update, and soft delete writes a snapshot to `customerHistory` with a `changeType` of `"created"`, `"updated"`, or `"deleted"`. Includes all fields at that point in time (name, email, phone, address, location IDs and resolved names). History is displayed in the admin UI as a timeline.

### OTP Authentication (`customer-auth.service.ts`)

**Flow:**
1. `sendOtp()` -- validates identifier format, normalizes phone to E.164, checks site settings for allowed auth method, resolves/validates the transport before mutating KV, verifies encrypted WhatsApp credentials when `authVerificationMethod = "whatsapp_otp"`, enforces IP rate limiting (5 requests/10 min via KV), enforces per-identifier cooldown (2 min), generates 6-digit cryptographic OTP, stores in KV with 5-min TTL and 0 attempts counter, and returns a queue payload with `deliveryKey` + `otpExpiresAt`
2. `/send-otp` enqueues `auth.send_otp` to `AUTH_OTP_QUEUE`; if queue handoff fails after KV write, it deletes the exact `cust_otp:*` key and returns retryable `503`
3. Queue consumer (in `apps/api/src/queue-consumer.ts`) claims `auth_otp_delivery_receipts` before provider work, skips terminal/expired receipts, then delivers OTP via the selected transport (email, SMS, WhatsApp)
4. Delivery success marks the receipt `accepted` with provider refs/status. Retryable failures mark `failed` with bounded error/provider metadata so Cloudflare Queue retries can reclaim the receipt.
5. `verifyOtp()` -- normalizes identifier to E.164 for phone method, validates code against KV, enforces max 5 attempts (increments counter in KV), on success: looks up or creates customer in DB, creates 30-day session in KV, returns session token

**Delivery idempotency:**
- Email sends pass `deliveryKey` as `idempotencyKey`; Resend forwards it as `Idempotency-Key`, while Cloudflare Email stores the returned `messageId`
- SMS sends pass `createAuthOtpProviderClientReference()` as deterministic `clientReference`; GenNet maps this to `csms_id`
- WhatsApp sends parse and store Meta message IDs from successful template-message responses
- OTP codes stay only in KV/queue payloads. The D1 receipt stores recipient hash/mask, status, provider refs, bounded response summaries, and OTP expiry, never the code.

**Session management:**
- Cookie name: `cs_tok` (HttpOnly, Secure)
- Companion cookie: `cs_auth` (non-HttpOnly, for client-side auth state detection)
- Session prefix in KV: `cust_session:`
- Session TTL: 30 days
- `getCustomerBySession()` checks expiry, deletes expired sessions
- `updateCustomerProfile()` updates the DB record and mirrors the customer name into the KV session. Address/city/zone fields are persisted in D1 but are not mirrored into the session object.

**Transport selection:**
- Site settings `authVerificationMethod` controls allowed methods
- `"email"` -> only email allowed
- `"phone"` or `"sms_otp"` -> only phone (SMS) allowed
- `"whatsapp_otp"` -> only phone (WhatsApp) allowed
- `"both"` -> email and phone allowed
- WhatsApp OTP validates encrypted Meta credentials before KV mutation, but the queue payload carries no provider secrets; the API queue consumer resolves/decrypts the token and phone-number ID at send time

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
| DELETE | `/{id}` | `deleteCustomer` | Soft delete with history record |
| DELETE | `/{id}/permanent` | `permanentlyDeleteCustomer` | Hard delete + cascade history |
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

- `@scalius/database` -- `customers`, `customerHistory`, `authOtpDeliveryReceipts`, `deliveryLocations`, `siteSettings`, `orders` (the latter three accessed in route handlers, not the service)
- `@scalius/shared/customer-utils` -- `phoneNumberSchema`, `validateAndFormatPhone`, `isValidPhoneNumber`, `formatPhoneForDisplay`, `calculateCustomerStats`
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

**`authOtpDeliveryReceipts`** table:
- `id` (PK, `aor_` prefix), `deliveryKey` (unique), `purpose` (`customer_login` today), `method`, `channel`, `provider`
- `identifierHash` + `identifierMasked` for audit/debug without storing raw recipient in receipt search paths
- `status`: `"pending"`, `"processing"`, `"accepted"`, `"delivered"`, `"failed"`, `"skipped"`
- Claim fields: `attempts`, `nextAttemptAt`, `claimId`, `claimExpiresAt`, `lastAttemptAt`, `lastError`
- Provider fields: `providerMessageId`, `providerStatus`, `rawResponse`
- Lifecycle fields: `acceptedAt`, `deliveredAt`, `failedAt`, `skippedAt`, `otpExpiresAt`, `createdAt`, `updatedAt`

**FTS5 index** (`customers_fts`):
- Content table: `customers`
- Indexed columns: `name`, `phone`, `email`
- Auto-maintained via SQLite triggers (insert/update/delete)

## Known Gaps

1. **History route not in service**: The `GET /{id}/history` endpoint contains significant business logic inline in the route handler (batch query for customer + history + orders, location enrichment) rather than delegating to the service layer.

2. **Index barrel omission**: `index.ts` only re-exports `customers.service`. `customer-auth.service.ts` and `otp-transport.ts` must be imported by direct path.

3. **SMS transport**: `SmsOtpTransport.validateConfig()` returns `null` because SMS provider selection lives in settings. Queue delivery fails/retries with a receipt error if `getActiveSmsProvider()` cannot resolve a configured provider. Supported providers: smsnetbd, bdbulksms, mimsms, gennet.

4. **Profile update limitations**: `updateCustomerProfile()` (storefront) only syncs `name` back to the KV session. Address/city/zone/cityName/zoneName are updated in DB but not reflected in the session object.

5. **No email update for existing customers**: `verifyOtp()` fills in `resolvedEmail` from the existing customer record but never updates it if the customer authenticates with a new email address.
