# Customers

Customer records, the buyer's sign-in by one-time code, the identity rules that tie orders to accounts, tags, saved segments and the CSV export. For contributors and coding agents.

- Layer L2. The domain imports only `settings` (`scripts/core-domain-graph.allow.json`).
- Two entries. `index.ts` is the server API. `browser.ts` is the closed browser-safe entry: it exports only `otp-transport.ts` (`OtpQueuePayload`, `buildOtpQueuePayload`).
- Main files: `customers.service.ts` (admin records), `addresses.ts` (the address book and the one address resolution), `customer-identity.ts` (identity rules), `customer-auth.service.ts` (sign-in, sessions, cookies, profile), `customer-auth-otp-challenges.ts`, `customer-auth-rate-limit.ts`, `otp-delivery-receipts.ts`, `customer-code-channels.ts` and `sign-in-readiness.ts` (channels and readiness), `customer-tags.ts`, `customer-segments.ts` and `customer-export.ts`.
- Not here: the buyer's account orders and guest-order claims (`orders`: `account-orders.ts`, `account-claims.ts`), marketing consent (`customer-marketing`), and order codes for Track your order and payment recovery (`orders`; they use the code channels from this domain).

## Identity rules (`customer-identity.ts`)

A phone or e-mail typed at checkout or sign-up is a claim. It never claims, renames, re-emails or merges an existing customer, never moves orders and never blocks the real owner. Only a code-verified identifier owns an account.

| Kind (`customerKind`) | Meaning |
| --- | --- |
| `account` | `accountClaimedAt` is set. A buyer signed up by code. |
| `guest` | A record made at checkout (`origin = order`), keyed by phone. It can hold several people's orders. A guest without a phone is keyed by its e-mail. |
| `merchant` | Made or named in the dashboard (`origin = merchant`). |

- Unique indexes on `customers`: `customers_verified_phone_unique`, `customers_verified_email_unique` (`lower(email)`), `customers_guest_phone_unique` (guests with a phone) and `customers_guest_email_unique` (`lower(email)` of guests without a phone, migration 0117). Only a proven identifier, a guest phone or a phoneless guest's e-mail is unique.
- `phoneVerifiedAt`, `emailVerifiedAt`, `accountClaimedAt` and `lastAuthenticatedAt` are set only by code proof. Admin writes never infer verification. `customers.phone` is the contact given, a claim until proven.
- A contact without a phone: `customers.phone`, `customer_history.phone` and `orders.customer_phone` stay NOT NULL and store `NO_PHONE` (`''`). The column type (`contactPhone`) reads it back as null, and writes use `storedPhone()`. Raw SQL uses `contactPhoneSql()`. No code compares a phone with `''` (a guard test checks this). Search, merge and "same phone" links never match two phoneless records.
- Order filing (`chooseOrderCustomer`): the account that verified the phone, else the account that verified the e-mail, else the phone's guest record (without a phone: the e-mail's phoneless guest record), else a new guest record. An order an account owns is filed under that account (`orders.customer_id = orders.account_owner_customer_id`).
- After an account proves a contact, `buildVerifiedContactOrderLink` moves every unowned order with that contact into the account and writes `order_moved_out` and `order_moved_in` history rows. A guest record left with no orders is retired (`deleted_at`, `merged_into_customer_id`). Its tags, custom fields and marketing consent move to the account.

## Sign in by code (`customer-auth.service.ts`)

The browser calls the storefront same-origin proxy `/api/customer-auth/*`. The proxy forwards to the API Worker through a service binding, strips `Domain=` from cookies and rewrites `SameSite=None` to `Lax`.

`POST /send-otp` (`sendOtp`):

1. Normalise the identifier: e-mail lower-case, phone to E.164 under the `customer_countries` policy.
2. Pick the channel from the `customer_auth` settings document. An unchosen channel throws 403, and a code never moves to another channel. An unready provider throws 503 (`assertCustomerChannelReady`).
3. Count the request against the send limits (below). A resend inside the cooldown returns 429.
4. Derive the 6-digit code: HMAC of `customer-auth-otp-delivery:<otpKey>:<deliveryKey>`, key `CREDENTIAL_ENCRYPTION_KEY`. The code is never stored. Upsert the `customer_auth_otp_challenges` row.
5. Send `auth.send_otp` to `JOBS_QUEUE`. The payload holds only `challengeKey`, `deliveryKey`, `purpose`, `otpExpiresAt`, `method`, `allowedMethod` and `channel`. If the queue refuses it, `enqueueAuthOtp` (`apps/api/src/utils/otp-queue.ts`) delivers from `waitUntil`. With no execution context the route deletes the challenge and returns 503.

Sending a code never reveals whether an account exists. Only `verifyOtp` decides that, after the code is right.

The queue consumer (`apps/api/src/queue-consumer.ts`) decrypts the delivery target from the challenge row and claims the `auth_otp_delivery_receipts` row for the `deliveryKey` (5-minute lease; accepted, delivered and skipped receipts end the job). It derives the code again and sends it by e-mail, SMS or WhatsApp. Success marks the receipt `accepted`. A retryable failure marks it `failed` and the queue retries. An expired code or a terminal failure marks it `skipped`, and a provider setup failure also blocks that provider until the merchant saves its settings. Raw `code`, `identifier` and `name` fields in the queue payload are a legacy fallback that new messages never carry. Logs carry only short hash prefixes.

`POST /verify-otp` (`verifyOtp`):

1. Find the owner of the proven identifier (`resolveProofOwner`): an e-mail resolves only to an account whose e-mail is verified, a phone only to an account whose phone is verified.
2. Owner found: consume the code atomically, set `emailVerifiedAt` or `phoneVerifiedAt` and `lastAuthenticatedAt`, and create the session.
3. No owner: check the code without using it up (it stays valid 10 minutes). A closed (soft-deleted) account gets "contact the store". Otherwise the route returns `needs_account_details` with a `suggestion` read from the latest order placed with that contact.
4. The second call carries `account` (`name`, `phone`, `email`, `saveOrderAddress`). The name is required. An e-mail sign-up gives a phone unless the store opted in to orders without a phone (`newAccountPhoneNeed`). The e-mail is required when `customer_auth.email` is `required`. One batch inserts the customer (`origin = account`), a `signed_up` history row, the session and the verified-contact order link. With `saveOrderAddress`, the same batch copies the latest order's address snapshot as the first (default) address.

A phone typed during an e-mail sign-up is only a contact. Proving it by code links its orders: `POST /phone/send-code` and `POST /phone/verify`.

### Challenge row and send limits

The challenge key is `cust_otp:<channel>:<HMAC of identifier>`. A code lives 5 minutes (`OTP_TTL_SECONDS`). Five wrong attempts set status `locked` (statuses: `pending`, `consumed`, `locked`). The row stores the HMAC code hash, the previous code hash, an identifier mask and the delivery target encrypted (`enc:` AES-GCM), never the code. Scheduled maintenance deletes expired and stale terminal rows.

Send limits (`customer-auth-rate-limit.ts`) use the D1 table `customer_auth_otp_rate_limits` with hashed keys. No native Workers limiter guards the OTP routes.

| Bucket | Limit |
| --- | --- |
| One contact from one IP | 5 per 15 minutes |
| One contact, all sources | 10 per hour. When it trips, the last sent code stays valid up to 30 more minutes. |
| One IP | 30 per 10 minutes (many Bangladeshi buyers share one carrier address) |
| Resend cooldown | 60 seconds, doubling with recent sends, at most 10 minutes |
| Newsletter signup | 20 per IP per 10 minutes, 5 per contact per hour |

## Sessions

| Item | Value |
| --- | --- |
| Cookie `cs_tok` | The raw session token. `HttpOnly`, `Secure`, `Path=/`, 30 days (`SESSION_TTL_SECONDS`). |
| Cookie `cs_auth` | `1`. Not `HttpOnly`; the storefront reads it for client-side auth state. |
| `SameSite` | `None` unless the storefront URL is a local development host; then `Lax`. |
| `Domain` | Set only when the Platform setting `customerAuthCookieDomain` is a valid multi-label host. Otherwise host-only. |
| Row `customer_sessions` | `token_hash` (primary key), `customer_id`, `expires_at`, `revoked_at`. Only the hash is stored, keyed by `CUSTOMER_SESSION_HASH_KEY` (derived from `SCALIUS_SECRET`). |

- The selected relational provider is the authority for sessions. KV is not consulted. `getCustomerBySession` requires an unrevoked, unexpired row and a live (not soft-deleted) customer.
- `POST /logout` clears the cookies and revokes the row. The storefront proxy `/api/auth/logout` also clears the order-receipt cookies.
- Soft-deleting a customer revokes its sessions. `cleanupExpiredCustomerSessions` deletes expired rows and revoked rows older than 7 days.
- `updateCustomerProfile` (`PUT /profile`) saves the name. The profile and the session carry `defaultAddress` (joined in the statement that reads them). `profileComplete` means the default address is complete (a line and, in Bangladesh, a city and thana) and was not saved with validation skipped. It is never required.

## Address book (`addresses.ts`, MARKETS-DESIGN D7)

- Table `customer_addresses` (migration 0113): canonical fields (`country_code`, `name`, `company`, `line1`, `line2`, `dependent_locality`, `locality`, `admin_area`, `postal_code`, `phone_e164`, `phone_raw`, `validation_skipped`) and the Bangladesh adapter (`city`, `zone`, `area` ids and names). At most one default per customer (partial unique index `customer_addresses_default_unique`). At most 50 addresses (`MAX_CUSTOMER_ADDRESSES`). The adapter columns are for Bangladesh only (check constraint).
- `resolveAddress()` is the one resolution for the address book, staff orders and agents: the country's rules (`@scalius/shared/address-metadata`) decide what is required and drop unused fields; a known admin area is stored as its code. A Bangladesh address resolves its City/Thana/Area ids to active delivery locations in one statement, and the adapter fills `locality` (city name) and `dependent_locality` (thana name), never `admin_area`. The phone is read in the address country (E.164). Staff may pass `skipValidation`: the address is kept as typed and marked `validation_skipped`; a value too long for its field is never kept. A buyer never skips. A refusal is `AddressValidationError` (`details.reason = "address_invalid"`, `details.issues` per field).
- `createCustomerAddress`, `updateCustomerAddress`, `setDefaultCustomerAddress`, `deleteCustomerAddress`, `listCustomerAddresses`: the first address is the default; a new default clears the old one in the same batch; deleting the default promotes the most recently changed other address.
- First address of a new record: its id is `firstCustomerAddressId(customerId)` (`caddr_<customer id>`). Staff create, a new account with `saveOrderAddress`, a staff order edit or amendment that makes a new record, the store import and trigger `orders_seed_customer_address` use it. Its insert announces no `customer.updated`: the record's `customer.created` carries it, as when the address was a customer column. Every later address change is a `customer.updated`.
- Trigger `orders_seed_customer_address`: a guest record (no account) without addresses takes its first shipping order's snapshot as its default address, for every order writer, with no extra statement in their batches. An order never writes an account's address book.
- Routes: staff `dashboard.customers.addresses_{list,create,update,set_default,delete}` (`/api/v1/admin/customers/{id}/addresses`, `customers.view` to list, `customers.edit` to change); the signed-in buyer `/api/v1/customer-auth/addresses` (cookie, excluded from agents); agents `storefront.customer_addresses.manage` (one action per call, live delegated authority).
- Privacy: the address book is private (`CACHE_DEP_EXEMPT_TABLES` in `@scalius/shared/cache-deps`): only the account, staff and agents with grants read it, never a public cached read.

## Code channels and readiness

The `customer_auth` settings document (Settings > Customer accounts, defined in `settings/documents.ts`, policy in `@scalius/shared/customer-auth-policy`) is the one source for checkout fields and code channels:

```text
{ email: required | optional | hidden, whatsapp: off | same_as_phone | separate, channels: (email | sms | whatsapp)[], phoneOptionalForDigital: boolean }
```

The default is `{ email: optional, whatsapp: off, channels: [email], phoneOptionalForDigital: false }`. A document saved before the opt-in existed reads it as `false`.

- The phone rule is `orderContactNeeds()` in `@scalius/shared/customer-auth-policy` (owner decision 2026-10-07). An order needs a phone when a line is delivered or picked up, when it is paid in cash or by deposit, when it is placed in Bangladesh (its shipping country, else its market's), or when the merchant has not opted in. With the opt-in (`phoneOptionalForDigital`), an order of only digital, service or gift-card lines, paid in full online outside Bangladesh, may go without a phone, and e-mail is then required. The opt-in needs checkout to ask for e-mail and e-mail codes to be on (`customerIdentityProblem`).
- Bangladesh orders always need a phone. Phone collection stays mandatory for Bangladesh customer identity and checkout.
- A channel can be chosen only when checkout collects its contact (`isChannelCollected`). `isCustomerAuthChannelReady` checks the provider (e-mail or SMS provider readiness, or the WhatsApp token and phone-number ID). It needs `CREDENTIAL_ENCRYPTION_KEY` and returns false on any read error.
- `getCustomerSignInReadiness` blocks checkout only when guest checkout is off and no chosen channel can send. `getOfferedCustomerIdentity` returns the chosen channels that can send now and never adds one.
- Order codes go only to a contact saved on the order (`listOrderCodeOptions`, `chooseOrderCodeChannel`).

## Admin records (`customers.service.ts`)

- **List.** Keyset (`after`, `before`) with `page` for the first rows only (1,000 on Free, 10,000 on Paid; `PAGE_TOO_DEEP` beyond). Search: FTS5 `customers_fts` (name, phone, e-mail) plus a phone `LIKE`. Filters: `tag`, `segment`, `subscribed`. Trash hides merged guest records.
- **Create** makes a `merchant` customer, refuses a phone another active customer uses, applies the `customer_countries` policy and writes a `created` history row. Without a phone, it needs an e-mail no other phoneless customer uses and the store's opt-in. A saved phone can be changed but not removed. **Update** writes nothing when no field changes, otherwise an `updated` row. Naming a guest record makes it `merchant`.
- **Soft delete** sets `deleted_at`, revokes sessions and writes `deleted`. **Restore** clears `deleted_at` and writes `restored`. A merged guest record cannot be restored.
- **Permanent delete** is refused when any order has the customer as `customer_id` or `account_owner_customer_id`. Otherwise it deletes sessions, history and the customer. Bulk delete is soft (no history rows) or permanent (same guard).
- `customer_order_stats` supplies order facts for the list, sorting, segments and export. Triggers on `orders` recompute a customer's row; application code never writes it. It counts real orders only (not `incomplete`, not deleted) and positive paid spend in minor units. `customers.total_orders` and `last_order_at` are counters that `checkout/commit.ts` and `orders/admin/*` write. Spend has no column.
- Each `customer_history` row (types: created, updated, deleted, restored, signed_up, order_linked, order_moved_in, order_moved_out) snapshots the profile, the actor (`staff`, `buyer`, `system`) and, for moves, the order and the verified contact.

## Tags, segments, export

| Item | Rules |
| --- | --- |
| Tags (`customer_tag_links`) | Normalised: NFC, lower-case, spaces collapsed, no commas, 1 to 40 characters. At most 50 per customer, 10 per bulk request, 500 customers per bulk request. Bulk writes bind ids and tags as one JSON value (`json_each`). |
| Segments (`customer_segments`) | A saved filter, evaluated live as one `WHERE` over `customers` and `customer_order_stats`. At most 12 conditions (36 bound values), 200 live segments, name 1 to 80 characters unique ignoring case. Updates need `expectedRevision` (409 when stale). Soft delete only, refused while a live promotion uses it. Match `all` or `any`. Counts stop at 100,000 (`capped`). |
| CSV export | Live customers of a filter, a segment or up to 100 chosen ids. Keyset pages of 200, at most 10,000 rows and 16 MiB. Spreadsheet-safe cells. Header `X-Export-Limited` says when it stopped early. |

Segment fields and limits are in `packages/shared/src/customer-marketing.ts`. Money in segment definitions is decimal major units at the HTTP edge and minor units in storage.

## Routes

Admin routes (`apps/api/src/routes/admin/customers.ts`, `customer-marketing.ts`) under `/api/v1/admin/customers`. Permission rules are in `packages/core/src/auth/rbac/route-permissions/customers.ts`.

| Method and path | Permission |
| --- | --- |
| `GET /` list, `GET /{id}` detail, `GET /{id}/history` | `customers.view` |
| `POST /` | `customers.create` |
| `PUT /{id}`, `POST /{id}/restore` | `customers.edit` |
| `DELETE /{id}`, `DELETE /{id}/permanent`, `POST /bulk-delete` | `customers.delete` |
| `GET /tags`, `GET /export`, `GET /segments`, `GET /segments/{id}`, `/count`, `/members`, `POST /segments/preview` | `customers.view` |
| `POST /tags/bulk`, `PUT /{id}/tags`, `POST /segments`, `PUT` and `DELETE /segments/{id}` | `customers.edit` |
| `GET /{id}/marketing`, `PUT /{id}/marketing` | `customers.view`, `customers.edit` |

`/{id}/history` pages history and orders by page number, not by cursor.

Buyer routes under `/api/v1/customer-auth` (`apps/api/src/routes/customer-auth/`): `POST /send-otp`, `POST /verify-otp`, `GET /me`, `POST /logout`, `PUT /profile`, `POST /phone/send-code`, `POST /phone/verify`, and `GET`, `PUT /marketing`. The other routes in that folder (orders, conversations, downloads, gift cards, reviews, warranties) belong to other domains.

## Data

Tables: `packages/database/src/schema/customers.ts` (`customers`, `customer_history`, `customer_auth_otp_challenges`, `customer_sessions`, `customer_auth_otp_rate_limits`, `auth_otp_delivery_receipts`) and `customer-marketing.ts` (tags, segments, `customer_order_stats`). `customers.origin` is `order`, `merchant` or `account`. `auth_otp_delivery_receipts` has `purpose` `customer_login` for sign-in codes. Payment-recovery and order-lookup codes keep their challenge in `order_payment_recovery_challenges` and use the same receipt table.
