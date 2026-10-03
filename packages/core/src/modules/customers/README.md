# Customers

Customer records, the buyer's sign-in by one-time code, the identity rules that tie orders to accounts, tags, saved segments and the CSV export. For contributors and coding agents.

- Layer L2. The domain imports only `settings` (`scripts/core-domain-graph.allow.json`). `agent-storefront`, `checkout`, `customer-marketing`, `orders` and `promotions` import it.
- Two entries. `index.ts` is the server API. `browser.ts` is the closed browser-safe entry: it exports only `otp-transport.ts` (`OtpQueuePayload`, `buildOtpQueuePayload`).
- Not here: the buyer's account orders and guest-order claims live in `orders` (`account-orders.ts`, `account-claims.ts`). Marketing consent lives in `customer-marketing`. Order codes (Track your order, payment recovery) live in `orders`; they use the code channels from this domain.

## Files

| File | Purpose |
| --- | --- |
| `customers.service.ts` | Admin list, detail, create, update, delete, restore. Paid-spend projections. |
| `customers.validation.ts` | `createCustomerSchema`, `updateCustomerSchema`. |
| `customer-identity.ts` | The identity rules: order filing, verified-contact order link, `customerKind`, history rows. |
| `customer-auth.service.ts` | `sendOtp`, `verifyOtp`, account phone proof, sessions, cookies, profile update. |
| `customer-auth-otp-challenges.ts` | The D1 challenge row: persist, claim, extend, delete, cleanup. |
| `customer-auth-rate-limit.ts` | D1 send limits for codes and newsletter signups. |
| `otp-delivery-receipts.ts` | The delivery receipt the queue consumer claims and marks. |
| `otp-transport.ts` | The `auth.send_otp` queue payload type and builder. |
| `customer-code-channels.ts` | Channel choice and fail-closed readiness for every code. |
| `sign-in-readiness.ts` | Which code channels can send now; whether required accounts block checkout. |
| `customer-tags.ts`, `customer-segments.ts`, `customer-export.ts` | Tags, saved segments, CSV export. |

## Identity rules (`customer-identity.ts`)

A phone or e-mail typed at checkout or sign-up is a claim. It never claims, renames, re-emails or merges an existing customer. It never moves orders. It never blocks the real owner. Only a code-verified identifier owns an account.

| Kind (`customerKind`) | Meaning |
| --- | --- |
| `account` | `accountClaimedAt` is set. A buyer signed up by code. |
| `guest` | A record made at checkout (`origin = order`), keyed by phone. It can hold several people's orders. |
| `merchant` | Made or named in the dashboard (`origin = merchant`). |

- Unique indexes on `customers`: `customers_verified_phone_unique`, `customers_verified_email_unique` (`lower(email)`) and `customers_guest_phone_unique`. Only a proven identifier or a guest phone is unique.
- Order filing (`chooseOrderCustomer`): the account that verified the phone, else the account that verified the e-mail, else the phone's guest record, else a new guest record.
- Invariant: an order an account owns is filed under that account (`orders.customer_id = orders.account_owner_customer_id`).
- After an account proves a contact, `buildVerifiedContactOrderLink` moves every unowned order with that contact into the account. It writes `order_moved_out` and `order_moved_in` history rows. A guest record left with no orders is retired (`deleted_at`, `merged_into_customer_id`). Its tags, custom fields and marketing consent move to the account.

## Sign in by code (`customer-auth.service.ts`)

The browser calls the storefront same-origin proxy `/api/customer-auth/*`. The proxy forwards to the API Worker through a service binding. It strips `Domain=` from cookies and rewrites `SameSite=None` to `Lax`.

`POST /send-otp` runs `sendOtp`:

1. Normalise the identifier: e-mail lower-case, phone to E.164 under the `customer_countries` policy.
2. Pick the channel from the `customer_auth` settings document. An unchosen channel throws 403. A code never moves to another channel.
3. Check the channel provider can send (`assertCustomerChannelReady`). An unready channel throws 503 with its own message.
4. Count the request against the send limits (below).
5. Derive the 6-digit code: HMAC of `customer-auth-otp-delivery:<otpKey>:<deliveryKey>`, key `CREDENTIAL_ENCRYPTION_KEY`. The code is never stored.
6. Upsert the `customer_auth_otp_challenges` row. A resend inside the cooldown returns 429.
7. The route sends `auth.send_otp` to `JOBS_QUEUE`. The payload holds only `challengeKey`, `deliveryKey`, `purpose`, `otpExpiresAt`, `method`, `allowedMethod` and `channel`. If the queue refuses it, `enqueueAuthOtp` (`apps/api/src/utils/otp-queue.ts`) delivers from `waitUntil`. With no execution context the route deletes the challenge and returns 503.

Sending a code never reveals whether an account exists. Only `verifyOtp` decides that, after the code is right.

The queue consumer (`apps/api/src/queue-consumer.ts`) delivers the code:

1. It reads the encrypted delivery target from the challenge row and decrypts it with `CREDENTIAL_ENCRYPTION_KEY`.
2. It claims the `auth_otp_delivery_receipts` row for the `deliveryKey` (5-minute lease). Accepted, delivered and skipped receipts end the job.
3. It derives the code again and sends it by e-mail, SMS or WhatsApp. E-mail passes `deliveryKey` as the idempotency key. SMS passes `createAuthOtpProviderClientReference()`.
4. Success marks the receipt `accepted`. A retryable failure marks it `failed` and the queue retries. An expired code or a terminal failure marks it `skipped`. A provider setup failure also blocks that provider until the merchant saves its settings.

Raw `code`, `identifier` and `name` fields in the queue payload are a legacy fallback. New messages never carry them. Logs carry only short hash prefixes.

`POST /verify-otp` runs `verifyOtp`:

1. Find the owner of the proven identifier (`resolveProofOwner`). An e-mail resolves only to an account whose e-mail is verified. A phone resolves only to an account whose phone is verified.
2. Owner found: consume the code atomically, set `emailVerifiedAt` or `phoneVerifiedAt` and `lastAuthenticatedAt`, and create the session.
3. No owner: check the code without using it up (it stays valid 10 minutes). A closed (soft-deleted) account gets "contact the store". Otherwise the route returns `needs_account_details` with a `suggestion` read from the latest order placed with that contact.
4. The second call carries `account` (`name`, `phone`, `email`, `saveOrderAddress`). The name is required. The phone is required (an e-mail sign-up must give one). The e-mail is required when `customer_auth.email` is `required`. One batch inserts the customer (`origin = account`), a `signed_up` history row, the session and the verified-contact order link.

A phone typed during an e-mail sign-up is only a contact. Proving it by code links its orders: `POST /phone/send-code` and `POST /phone/verify` (`sendAccountPhoneCode`, `verifyAccountPhoneCode`).

### Challenge row

| Rule | Value |
| --- | --- |
| Key `otp_key` | `cust_otp:<channel>:<HMAC of identifier>` |
| Code lifetime | 5 minutes (`OTP_TTL_SECONDS`) |
| Wrong attempts | 5, then status `locked` |
| Stored | HMAC code hash, previous code hash, identifier mask, delivery target encrypted (`enc:` AES-GCM). Never the code. |
| Status | `pending`, `consumed`, `locked` |
| Cleanup | Scheduled maintenance deletes expired and stale terminal rows (`apps/api/src/scheduled-maintenance.ts`). |

### Send limits (`customer-auth-rate-limit.ts`)

D1 table `customer_auth_otp_rate_limits`. Keys are hashed (`customer_auth_otp:<scope>:<digest>`). No native Workers limiter guards the OTP routes.

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
| Row `customer_sessions` | `token_hash` (primary key), `customer_id`, `expires_at`, `revoked_at`. Only the hash is stored. |
| Hash key | `CUSTOMER_SESSION_HASH_KEY`, derived from `SCALIUS_SECRET` (purpose `customer-session-hash`). |

- The selected relational provider is the authority for sessions. KV is not consulted.
- `getCustomerBySession` hashes the token, requires an unrevoked, unexpired row and a live (not soft-deleted) customer.
- `POST /logout` clears the cookies and revokes the row. The storefront proxy `/api/auth/logout` also clears the order-receipt cookies.
- Soft-deleting a customer revokes its sessions. `cleanupExpiredCustomerSessions` deletes expired rows and revoked rows older than 7 days.
- `updateCustomerProfile` (`PUT /profile`) saves name, address, city, zone and area. It checks the active city, zone and area hierarchy. `profileComplete` means address, city and zone are saved. It is never required.

## Code channels and readiness

The `customer_auth` settings document (Settings -> Customer accounts, defined in `settings/documents.ts`, policy in `@scalius/shared/customer-auth-policy`) is the one source for checkout fields and code channels:

```text
{ email: required | optional | hidden, whatsapp: off | same_as_phone | separate, channels: (email | sms | whatsapp)[] }
```

The default is `{ email: optional, whatsapp: off, channels: [email] }`.

- Phone collection is mandatory for customer identity and checkout in Bangladesh. No merchant setting disables it.
- A channel can be chosen only when checkout collects its contact (`isChannelCollected`).
- `isCustomerAuthChannelReady` checks the provider: e-mail provider readiness, SMS provider readiness, or the WhatsApp token and phone-number ID. It needs `CREDENTIAL_ENCRYPTION_KEY` and returns false on any read error.
- `getCustomerSignInReadiness` blocks checkout only when guest checkout is off and no chosen channel can send.
- `getOfferedCustomerIdentity` returns the chosen channels that can send now. It never adds one.
- Order codes go only to a contact saved on the order (`listOrderCodeOptions`, `chooseOrderCodeChannel`). Errors: `NoOrderCodeChannelError`, `OrderCodeChannelUnavailableError`.

## Admin records (`customers.service.ts`)

| Action | Rule |
| --- | --- |
| List | Keyset (`after`, `before`) with `page` for the first rows only (1,000 on Free, 10,000 on Paid; `PAGE_TOO_DEEP` beyond). Search: FTS5 `customers_fts` (name, phone, e-mail) plus a phone `LIKE`. Sorts: `name`, `totalOrders`, `totalSpent`, `lastOrderAt`, `createdAt`, `updatedAt`. Filters: `tag`, `segment`, `subscribed`. Trash hides merged guest records. |
| Create | Staff creates a `merchant` customer. Refuses a phone another active customer uses. Applies the `customer_countries` policy. Resolves location names. Writes a `created` history row. |
| Update | Writes nothing when no field changes. Writes an `updated` history row. Naming a guest record makes it `merchant`. |
| Soft delete | Sets `deleted_at`, revokes sessions, writes `deleted`. |
| Restore | Clears `deleted_at`, writes `restored`. A merged guest record cannot be restored. |
| Permanent delete | Refused when any order has the customer as `customer_id` or `account_owner_customer_id`. Otherwise deletes sessions, history and the customer. |
| Bulk delete | Soft (no history rows) or permanent (same guard). |

- Order facts for the list, sorting, segments and export come from `customer_order_stats` (migration 0108). Triggers on `orders` recompute a customer's row; application code never writes it. It counts real orders only (not `incomplete`, not deleted) and positive paid spend in minor units.
- `customers.total_orders` and `last_order_at` are counters. `checkout/commit.ts` and `orders/admin/*` write them. Spend has no column.
- `customer_history` change types: `created`, `updated`, `deleted`, `restored`, `signed_up`, `order_linked`, `order_moved_in`, `order_moved_out`. Each row snapshots the profile, the actor (`staff`, `buyer`, `system`) and, for moves, the order, the related record and the verified contact.

## Tags, segments, export

| Item | Rules |
| --- | --- |
| Tags (`customer_tag_links`) | Normalised: NFC, lower-case, spaces collapsed, no commas, 1 to 40 characters. At most 50 per customer, 10 per bulk request, 500 customers per bulk request. Bulk writes bind ids and tags as one JSON value (`json_each`). |
| Segments (`customer_segments`) | A saved filter, evaluated live as one `WHERE` over `customers` and `customer_order_stats`. At most 12 conditions (36 bound values), 200 live segments, name 1 to 80 characters unique ignoring case. Updates need `expectedRevision` (409 when stale). Soft delete only, refused while a live promotion uses it. |
| Segment fields | `amount_spent`, `orders_count`, `last_order_date`, `first_order_date`, `customer_since`, `city`, `zone`, `tags`, `marketing_consent`, `customer_type`, `custom_field`. Match `all` or `any`. |
| Counts | One bounded query. Stops at 100,000 (`capped`). |
| CSV export | Live customers of a filter, a segment or up to 100 chosen ids. Keyset pages of 200, at most 10,000 rows and 16 MiB. Spreadsheet-safe cells. Header `X-Export-Limited` says when it stopped early. |

Definitions and limits are in `packages/shared/src/customer-marketing.ts`. Money in segment definitions is decimal major units at the HTTP edge and minor units in storage.

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

`customers`, `customer_history`, `customer_auth_otp_challenges`, `customer_sessions`, `customer_auth_otp_rate_limits` and `auth_otp_delivery_receipts` are in `packages/database/src/schema/customers.ts`. Tags, segments and `customer_order_stats` are in `customer-marketing.ts` (migration 0108).

| `customers` column | Meaning |
| --- | --- |
| `phone` (not null) | The contact given. A claim until proven. |
| `email` (nullable) | Same. |
| `accountClaimedAt`, `phoneVerifiedAt`, `emailVerifiedAt`, `lastAuthenticatedAt` | The account and proof state. Only code proof sets them. Admin writes never infer verification. |
| `origin` | `order`, `merchant` or `account`. |
| `mergedIntoCustomerId` | Set when a retired guest record joined an account. |
| `city`, `zone`, `area` and `*Name` | Location ids and their denormalised names. |
| `totalOrders`, `lastOrderAt` | Counters (see above). |
| `deletedAt` | Soft delete. |

`auth_otp_delivery_receipts` has `purpose` `customer_login` for sign-in codes. Payment-recovery and order-lookup codes keep their challenge in `order_payment_recovery_challenges` and use the same receipt table.
