# Customers

Customer management (admin CRUD) and OTP-based storefront authentication with pluggable transports.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel export -- re-exports `customers.service` only (not customer-auth) |
| `customers.service.ts` | Admin CRUD: `listCustomers`, `createCustomer`, `updateCustomer`, `deleteCustomer`, `permanentlyDeleteCustomer`, `restoreCustomer`, `bulkDeleteCustomers`, `getCustomerById`; storefront account order history/detail via `getCustomerOrders()` and `getCustomerOrderDetail()` with customer-scoped order facts. Re-exports schemas from `customers.validation.ts`. |
| `customers.validation.ts` | Canonical Zod schemas: `createCustomerSchema` (uses `phoneNumberSchema` from `@scalius/shared/customer-utils`), `updateCustomerSchema` (partial). Imported by both service and API routes. |
| `customer-auth.service.ts` | Storefront auth: `sendOtp()`, `verifyOtp()`, `getCustomerBySession()`, `deleteCustomerSession()`, `updateCustomerProfile()`. Cookie/session helpers. Imported directly by path (not through `index.ts`) |
| `customer-auth-rate-limit.ts` | D1-authoritative OTP send throttling for client IP buckets, plus bounded cleanup of expired windows |
| `otp-transport.ts` | `OtpTransport` interface + three implementations: `EmailOtpTransport`, `SmsOtpTransport`, `WhatsAppOtpTransport`. Factory: `getOtpTransport()` |
| `otp-delivery-receipts.ts` | D1 receipt helper for OTP delivery claims, accepted/failed/skipped marks, recipient hashing/masking, and provider client references |

## Features

### Admin CRUD (`customers.service.ts`)

- **List** with pagination, FTS5 full-text search (name/phone/email), multi-field sorting, soft-delete filtering (active vs trashed)
- **Create** with phone uniqueness check, delivery location name resolution (city/zone/area IDs to display names), auto history record (`changeType: "created"`)
- **Update** with phone uniqueness check (excluding self), location name re-resolution, auto history record (`changeType: "updated"`)
- **Soft delete** sets `deletedAt` timestamp, revokes active customer auth sessions, and writes a history record (`changeType: "deleted"`)
- **Restore** clears `deletedAt` (no history record)
- **Permanent delete** cascades: deletes customer auth sessions and `customerHistory` records first, then the customer
- **Bulk delete** supports both soft and permanent modes and revokes/deletes auth sessions for affected customers

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
1. `sendOtp()` -- validates sign-in vs sign-up intent as challenge metadata, validates identifier and secondary contact formats, normalizes phone to E.164, resolves the advanced customer-auth policy from `settings.customer_auth/policy` with `siteSettings.authVerificationMethod` fallback, requires phone collection for customer identity, resolves/validates the selected transport, verifies Email/SMS/WhatsApp provider readiness with the dedicated credential key before challenge mutation, passes a dedicated WhatsApp migration key so legacy credential cleanup cannot use JWT fallback encryption, enforces IP rate limiting (5 requests/10 min) through D1 `customer_auth_otp_rate_limits`, enforces per-channel identifier cooldown (2 min) through the D1 challenge upsert, generates 6-digit cryptographic OTP, stores only an HMAC code hash plus intent/channel/pinned-contact metadata in `customer_auth_otp_challenges` with 5-min TTL, and returns a generic queue payload with `deliveryKey` + `otpExpiresAt`. It intentionally does not look up account existence before sending, so sign-in/sign-up registration state is disclosed only after a valid OTP proves contact ownership.
2. `/send-otp` enqueues `auth.send_otp` to `AUTH_OTP_QUEUE`; if queue handoff fails after challenge creation, it deletes the exact D1 challenge by `otpKey` + `deliveryKey` and returns retryable `503`
3. Queue consumer (in `apps/api/src/queue-consumer.ts`) claims `auth_otp_delivery_receipts` before provider work, skips terminal/expired receipts, then delivers OTP via the selected transport (email, SMS, WhatsApp)
4. Delivery success marks the receipt `accepted` with provider refs/status. Retryable failures mark `failed` with bounded error/provider metadata so Cloudflare Queue retries can reclaim the receipt.
5. `verifyOtp()` -- normalizes identifier to E.164 for phone method, atomically consumes the matching channel-scoped D1 challenge, atomically increments wrong-code attempts, rechecks sign-up collection policy, uses the phone/email fields pinned when the OTP was issued, and on success signs in an existing customer or creates a new customer only for explicit `sign_up` intent before creating a 30-day D1 session keyed by an HMAC token hash. Unknown sign-in and duplicate sign-up guidance happens here, after OTP proof, not at send time.

**Delivery idempotency:**
- Email sends pass `deliveryKey` as `idempotencyKey`; Resend forwards it as `Idempotency-Key`, while Cloudflare Email stores the returned `messageId`
- SMS sends pass `createAuthOtpProviderClientReference()` as deterministic `clientReference`; GenNet maps this to `csms_id`
- WhatsApp sends parse and store Meta message IDs from successful template-message responses
- OTP plaintext stays only in the queue payload and provider request body. `customer_auth_otp_challenges` stores an HMAC hash of the code plus pinned contact metadata; the delivery receipt stores recipient hash/mask, status, provider refs, bounded response summaries, and OTP expiry, never the code.

**Session management:**
- Cookie name: `cs_tok` (HttpOnly, Secure)
- Companion cookie: `cs_auth` (non-HttpOnly, for client-side auth state detection)
- Session TTL: 30 days
- `customer_sessions` stores only `tokenHash`, `customerId`, expiry/revocation timestamps, and audit timestamps. The raw cookie token is never persisted.
- `getCustomerBySession()` hashes the cookie token, requires an active non-expired session row, joins the live `customers` row, and rejects soft-deleted/missing customers.
- `deleteCustomerSession()` revokes the D1 row; scheduled maintenance deletes expired and old revoked rows in bounded batches.
- `updateCustomerProfile()` updates the DB record and returns a fresh customer/session projection from D1.

**Transport selection and collection policy:**
- Phone number collection is a platform invariant for customer identity, checkout, delivery, fraud checks, SMS OTP, and WhatsApp OTP. Do not add a merchant setting that makes phone optional or uncollected.
- The advanced policy lives at `settings.customer_auth/policy` with `{ otpChannels, requiredContactFields, optionalContactFields, defaultOtpChannel }`; `siteSettings.authVerificationMethod` remains a legacy summary/fallback.
- OTP channels are independent: `"email"`, `"sms"`, and `"whatsapp"` may be enabled in any non-empty combination. The legacy summaries map to `"email"`, `"sms_otp"`, `"whatsapp_otp"`, and `"both"` for older callers.
- Email collection is independent of OTP channel: merchants may not collect email, collect it optionally, or require it while still verifying through SMS/WhatsApp.
- WhatsApp OTP validates encrypted Meta credentials before D1 challenge mutation, but the queue payload carries no provider secrets; the API queue consumer resolves/decrypts the token and phone-number ID at send time. Legacy WhatsApp token migration/cleanup requires the dedicated `migrationEncryptionKey`; `getEncryptionKey()` fallback output is read-only.

**Auto-registration:**
- Only explicit `sign_up` OTPs can create customers; explicit `sign_in` OTPs require an existing account and return a customer-facing "Create an account instead" error when none exists.
- New customer creation always requires a phone number and rejects duplicate phone/email before account creation.
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
| POST | `/logout` | `deleteCustomerSession` | Revoke D1 session, clear cookies |
| PUT | `/profile` | `updateCustomerProfile` | Update name/address/city/zone |
| GET | `/orders` | `getCustomerOrders` | Customer's latest 50 orders matched by `customerId` only, with items, product names/images, and one latest shipment summary for tracking display |
| GET | `/orders/{id}` | `getCustomerOrderDetail` + API payment recovery preview | Customer-scoped order detail, items, shipments, payments, payment plan, COD, notification receipts, timeline, and policy-backed `paymentRecovery` preview |
| POST | `/orders/{id}/payment-session` | API payment session creation | Create an owned-order Stripe/SSLCommerz/Polar payment session from the customer session and order state; strict empty body; no receipt-token input/output |

## Data Flow

### Admin CRUD
```
Astro page (SSR) -> loader (apiGet) -> admin proxy -> API worker -> customers.service -> D1
                                                                                      -> customerHistory (audit)
```

### Storefront Auth
```
Browser -> storefront same-origin proxy (/api/customer-auth/*) -> API worker (service binding) -> customer-auth.service -> D1 (OTP challenges/rate limits/customers/customer_sessions)
```

The storefront proxy rewrites cookies (strips `Domain=`, changes `SameSite=None` to `Lax`) to ensure browser compatibility. A separate `/api/auth/logout` proxy handles logout with explicit cookie clearing.

### Customer Stats
```
Order create/update (orders domain) -> calculateCustomerStats() -> UPDATE customers SET totalOrders, totalSpent, lastOrderAt
Customer account order history -> getCustomerOrders() -> orders + orderItems/product images + latest deliveryShipments/deliveryProviders summary
Customer account order detail -> getCustomerOrderDetail() -> order + items + shipments + payments + paymentPlan/COD + notification receipts + timeline
Customer account payment recovery -> API customer-auth route -> shared payment-session policy/gateway readiness/attempt helpers -> gateway
```

`paymentRecovery` is intentionally assembled in `apps/api/src/routes/customer-auth.ts` via `routes/payment/payment-session-create.ts`, not in this core customer module. The preview depends on fresh checkout-flow settings, gateway credential readiness, and public payment-session policy; duplicating that in core without the API route context would invite stale or inconsistent buyer copy.

## Dependencies

- `@scalius/database` -- `customers`, `customerHistory`, `customerAuthOtpChallenges`, `customerAuthOtpRateLimits`, `customerSessions`, `authOtpDeliveryReceipts`, `deliveryLocations`, `deliveryShipments`, `deliveryProviders`, `siteSettings`, `orders`
- `@scalius/shared/customer-utils` -- `phoneNumberSchema`, `validateAndFormatPhone`, `isValidPhoneNumber`, `formatPhoneForDisplay`, `calculateCustomerStats`
- `@scalius/core/errors` -- `ValidationError`, `ForbiddenError`, `RateLimitError`, `ServiceUnavailableError`
- `@scalius/core/search` -- `ftsMatch` for FTS5 search
- Cloudflare KV (`CACHE` binding) -- no customer-auth OTP send/verify/session authority; legacy/generic cache binding only

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

**`customerAuthOtpChallenges`** table:
- `otpKey` (PK, channel-scoped `cust_otp:{channel}:{identifier}`), `deliveryKey` (unique queue/provider correlation)
- `method`, `channel`, `intent`, normalized `identifier`, `identifierHash`, `identifierMasked`
- Pinned sign-up contacts: `contactEmail`, `phone`
- `codeHash` stores an HMAC-SHA256 hash of `otpKey:code`, not the plaintext OTP
- `status`: `"pending"`, `"consumed"`, `"locked"`
- Attempt/cooldown fields: `attempts`, `maxAttempts`, `resendAvailableAt`, `expiresAt`, `consumedAt`
- Scheduled maintenance deletes expired and stale terminal challenges in bounded batches

**`customerSessions`** table:
- `tokenHash` (PK) stores an HMAC-SHA256 hash of the raw `cs_tok` cookie value, never the raw token
- `customerId` (FK cascade to `customers.id`)
- `expiresAt`, `revokedAt`, `createdAt`, `updatedAt`
- `customer_sessions_customer_id_idx` supports customer delete/revoke paths
- `customer_sessions_active_expiry_idx` supports active-session reads and scheduled cleanup

**`customerAuthOtpRateLimits`** table:
- `key` (PK) is a hashed bucket like `customer_auth_otp:ip:{digest}`, never a raw IP address
- `scope` is currently `"ip"`; `attempts` and `windowExpiresAt` enforce the 5-per-10-minute send window through guarded D1 writes
- `customer_auth_otp_rate_limits_window_idx` supports scheduled cleanup of expired windows

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

4. **Profile response limitations**: `updateCustomerProfile()` returns the fresh identity projection plus submitted address/location fields. Full persisted address/location reads still come from account/order profile endpoints rather than the auth session object.

5. **No email update for existing customers**: `verifyOtp()` fills in `resolvedEmail` from the existing customer record but never updates it if the customer authenticates with a new email address.

6. **Customer order list is intentionally capped**: `/customer-auth/orders` remains a latest-50 list endpoint with only summary shipment data. Full payment/shipment/notification timeline data belongs on `/customer-auth/orders/{id}`. Cursor pagination for older account orders and customer-facing return/cancel eligibility are still not implemented.
