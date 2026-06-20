# Customer Auth, Session, and Profile UX on Cloudflare

Date: 2026-06-20

Scope: Cloudflare-native customer OTP auth, session durability, storefront/admin session propagation, anti-flicker frontend state, and profile address/location UX for the Scalius Commerce monorepo.

Constraints followed:

- Repo inspection only for implementation claims.
- Cloudflare platform claims use current official Cloudflare docs only.
- No code changes.

## Executive conclusion

The current system is directionally good: customer auth is isolated in the API Worker, storefront auth goes through a same-origin Astro proxy, admin auth remains a separate Better Auth/D1 plane, OTP delivery is async through Cloudflare Queues, and delivery idempotency is fenced in D1.

The main architectural correction is durability ownership. KV is doing too much authoritative auth work today. Cloudflare positions KV as global, low-latency, read-heavy, and eventually consistent, and explicitly advises stronger consistency primitives for atomic/transactional needs. Customer sessions, OTP challenges, profile addresses, and delivery receipts should be D1-authoritative. KV should be limited to cache/hint/cooldown roles where a stale read only affects convenience, not auth correctness.

Simplified target:

```text
Browser
  -> Storefront same-origin proxy /api/customer-auth/*
  -> API Worker over BACKEND_API service binding
  -> D1 authoritative tables:
       customers
       customer_sessions
       customer_auth_challenges
       auth_otp_delivery_receipts
       customer_addresses or canonical customers address columns
  -> AUTH_OTP_QUEUE for delivery only
  -> KV for cache, coarse cooldown hints, and non-authoritative UI hints only

Admin dashboard
  -> TanStack Start server functions
  -> API Worker over API service binding
  -> Better Auth sessions in D1
```

## Cloudflare platform facts used

Official docs retrieved on 2026-06-20:

- Workers KV is global and low-latency, but it is eventually consistent. Writes are stored centrally and cached around Cloudflare's network; other locations can see old values for up to 60 seconds or more. Cloudflare says KV is not ideal for atomic operations or values that must be read and written in one transaction. Source: [How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/).
- KV concurrent writes to the same key can overwrite one another, and KV documents a same-key write limit of one write per second. Source: [Write key-value pairs](https://developers.cloudflare.com/kv/api/write-key-value-pairs/).
- Cloudflare Queues provide at-least-once delivery by default, so messages can be delivered more than once; Cloudflare recommends idempotency keys/database primary keys for duplicate-safe processing. Source: [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/).
- Queue consumers can `ack()` individual messages and `retry()` individual messages; without explicit acknowledgement, a failed message can cause batch redelivery. Source: [Batching, Retries and Delays](https://developers.cloudflare.com/queues/configuration/batching-retries/).
- Queue messages that reach max retries are deleted or moved to a DLQ if configured; DLQ messages without an active consumer persist for four days. Source: [Dead Letter Queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/).
- Service bindings let one Worker call another without a publicly accessible URL and are documented as zero added latency by default. Source: [Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/).
- D1 is Cloudflare's managed serverless SQLite database. Read replication requires the D1 Sessions API; otherwise queries keep running on the primary database. Sessions provide sequential consistency for queries in one logical session. Sources: [D1 overview](https://developers.cloudflare.com/d1/), [D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/), [D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/).
- Durable Objects provide stateful coordination and strongly consistent attached storage; new classes should use SQLite-backed Durable Objects. Source: [Durable Objects overview](https://developers.cloudflare.com/durable-objects/).

## Current repo architecture

### API customer auth

- `apps/api/src/routes/customer-auth.ts:121` handles `/send-otp`, calls `sendOtp()`, then enqueues `AUTH_OTP_QUEUE`; on queue handoff failure it deletes the exact OTP KV key and returns a retryable service error (`apps/api/src/routes/customer-auth.ts:157`).
- `/verify-otp` creates customer sessions and sets both `cs_tok` and `cs_auth=1` (`apps/api/src/routes/customer-auth.ts:272`).
- `/me`, `/orders`, and order detail responses set private no-store headers (`apps/api/src/routes/customer-auth.ts:43`, `apps/api/src/routes/customer-auth.ts:311`, `apps/api/src/routes/customer-auth.ts:519`).
- `/profile` updates D1 through `updateCustomerProfile()` and returns limited profile fields (`apps/api/src/routes/customer-auth.ts:427`).
- Customer order history is scoped by `session.customerId` only (`apps/api/src/routes/customer-auth.ts:531`).

### Core customer auth

- `packages/core/src/modules/customers/customer-auth.service.ts:32` defines `cs_tok`, `cust_session:`, and `cust_otp:`. Sessions and OTPs are currently KV-backed.
- OTP keys are channel-scoped (`packages/core/src/modules/customers/customer-auth.service.ts:38`).
- `sendOtp()` validates intent, policy, contact formats, duplicates, transport readiness, and rate limits before writing OTP KV (`packages/core/src/modules/customers/customer-auth.service.ts:347`).
- OTP queue payloads currently include the OTP code (`packages/core/src/modules/customers/otp-transport.ts:19`).
- `verifyOtp()` reads and mutates OTP state in KV, deletes/reputs on failed attempts, creates customers in D1, then writes the session to KV (`packages/core/src/modules/customers/customer-auth.service.ts:497`, `packages/core/src/modules/customers/customer-auth.service.ts:668`).
- `updateCustomerProfile()` updates D1 profile fields but only mirrors `name` back into the KV session (`packages/core/src/modules/customers/customer-auth.service.ts:722`).
- The README already calls out that address/city/zone are not mirrored into the session object (`packages/core/src/modules/customers/README.md:65`).

### OTP delivery queue

- API Worker binds `AUTH_OTP_QUEUE` and consumes `auth-otp` with DLQ configured (`apps/api/wrangler.jsonc:64`, `apps/api/wrangler.jsonc:99`).
- `apps/api/src/worker.ts:21` routes queue batches into `handleQueueBatch()`.
- `processAuthOtpQueueMessage()` claims a D1 delivery receipt before provider work, skips terminal/expired receipts, and marks accepted/failed/skipped (`apps/api/src/queue-consumer.ts:470`).
- `auth_otp_delivery_receipts` has a unique `deliveryKey`, claim fields, status fields, and provider refs (`packages/database/src/schema/customers.ts:59`).

### Storefront session propagation

- `apps/storefront/src/pages/api/customer-auth/[...path].ts:21` is the same-origin proxy. In production it calls the API Worker through `BACKEND_API`; locally it uses HTTP. It rewrites API `Set-Cookie` headers to host-only and `SameSite=Lax` (`apps/storefront/src/pages/api/customer-auth/[...path].ts:46`, `apps/storefront/src/pages/api/customer-auth/[...path].ts:82`).
- Storefront client calls all customer auth endpoints through the same-origin proxy with `credentials: "include"` (`apps/storefront/src/lib/api/customer-auth.ts:96`, `apps/storefront/src/lib/api/customer-auth.ts:120`, `apps/storefront/src/lib/api/customer-auth.ts:144`).
- `/api/auth/logout` clears host-only `cs_tok` and `cs_auth`, then best-effort forwards logout to the API Worker (`apps/storefront/src/pages/api/auth/logout.ts:16`).
- Storefront cache policy treats `cs_tok` and `cs_auth` as private-session cookies (`apps/storefront/src/lib/cache-policy.ts:1`).

### Storefront UX state

- `AuthModal` defers checkout-config and `/me` fetches until after page load to reduce critical request chains (`apps/storefront/src/components/AuthModal.tsx:97`).
- Header account link uses readable `cs_auth=1` as a UI hint, not backend authority (`apps/storefront/src/components/header/HeaderLayout.astro:353`).
- Cart uses `cs_auth` to decide whether to call `/me` for autofill on DOMContentLoaded (`apps/storefront/src/pages/cart.astro:595`).
- Cart listens for `customer-login` events to autofill fields after modal login (`apps/storefront/src/pages/cart.astro:607`).
- Account and order-detail pages render loading shells, call `/me`, then call private order endpoints (`apps/storefront/src/pages/account.astro:372`, `apps/storefront/src/pages/account/orders/[id].astro:313`).

### Profile/address/location UX

- Customer table stores a single address plus city/zone/area IDs and denormalized names (`packages/database/src/schema/customers.ts:8`).
- `AuthModal` uses React `LocationSelector` for profile setup and passes city/zone IDs plus names to `/profile` (`apps/storefront/src/components/AuthModal.tsx:290`, `apps/storefront/src/components/AuthModal.tsx:593`).
- Cart uses React `LocationSelector` and a `location-prefill` event API for autofill (`apps/storefront/src/components/LocationSelector.tsx:94`, `apps/storefront/src/pages/cart.astro:576`).
- Account page uses separate imperative select logic and stores city/zone names as select values (`apps/storefront/src/pages/account.astro:499`, `apps/storefront/src/pages/account.astro:595`).
- `/me` currently returns session identity only, not D1 address/location fields (`apps/api/src/routes/customer-auth.ts:328`), so fresh cart page loads cannot reliably autofill a saved delivery address.

### Admin session propagation

- Admin-v2 has a service binding named `API` to the API Worker (`apps/admin-v2/wrangler.jsonc:52`).
- Admin server functions forward `cookie` and `authorization` headers to the API Worker (`apps/admin-v2/src/lib/api.server.ts:68`) and append API `Set-Cookie` headers to the TanStack response (`apps/admin-v2/src/lib/api.server.ts:89`).
- Admin auth pages use Better Auth through the admin Worker route `/api/auth/*` (`apps/admin-v2/src/routes/api/auth/$.ts:12`).
- Hot admin guards use direct D1 session lookup for Better Auth cookies (`apps/admin-v2/src/lib/admin-session.server.ts:42`, `apps/admin-v2/src/lib/auth.fns.ts:175`).
- API admin middleware independently validates Better Auth session cookies or JWT/scanner sessions and then enforces RBAC (`apps/api/src/middleware/admin-auth.ts:56`).

## Main findings

### 1. KV-backed OTP and sessions are the main correctness risk

KV is excellent for public cache and read-heavy hints, but current customer auth treats it as the source of truth for:

- OTP challenges and attempts.
- Session token validity.
- Session revocation/logout.
- IP rate-limit counters.

That creates possible false negatives and false positives:

- A user receives an OTP, then `/verify-otp` hits a different Cloudflare location and sees a stale negative/old KV value.
- A user logs out, but another location can still read an old `cust_session:*` entry until KV propagation/caches settle.
- Same-key OTP attempt updates can race under retry or multi-tab verification.

The practical severity depends on traffic geography and whether storefront and API service-binding requests land consistently, but Cloudflare does not guarantee read-after-write for KV, even in the writing location.

### 2. OTP delivery idempotency is strong, but the queue payload should not contain OTP secrets

The D1 receipt pattern is right for Queue at-least-once delivery:

- Unique delivery key.
- Processing claim with lease.
- Terminal accepted/skipped states.
- Provider refs stored for audit.
- Expired OTP deliveries skipped.

However, `AuthOtpQueueMessage` currently carries `code` (`apps/api/src/queue-consumer.ts:152`, `packages/core/src/modules/customers/otp-transport.ts:19`). If a message is retried or dead-lettered, the OTP code exists outside the challenge store. Cloudflare DLQ docs matter here because unconsumed DLQ messages persist for four days.

Target: queue payload should carry `challengeId`, `deliveryKey`, `channel`, and recipient routing metadata, not the raw code. The consumer should read the D1 challenge, skip if expired/consumed/cancelled, decrypt or otherwise retrieve the short-lived delivery code, and send. Verification should compare against a D1-stored code hash.

### 3. Storefront same-origin proxy is the right cookie architecture

The storefront proxy is a good Cloudflare-native fit:

- It keeps browser auth calls same-origin.
- It uses service binding in production.
- It rewrites API cookies into host-only storefront cookies.
- It leaves the API Worker as the auth authority.

Keep this. Do not make browser code call the API domain directly for auth mutations if cookies are expected to stick to the storefront domain.

### 4. `cs_auth` is a useful UX hint, not authentication

The current use of `cs_auth=1` in header/cart is acceptable as long as it stays a hint:

- It can hide or show account affordances immediately.
- It can decide whether an eager `/me` probe is worth doing.
- It must never authorize private API calls.

The backend correctly uses `cs_tok` and server-side session lookup for authority. Tests should continue to assert this boundary.

### 5. Profile/address data is split and inconsistently shaped

Today, identity and address move through different paths:

- New signup profile setup updates D1 but `/me` does not return the saved address.
- Cart autofill reads `/me`, so it often gets name/phone/email but not saved address/location.
- Account page gets richer customer data through `/orders`, not through a profile endpoint.
- Modal/cart use `LocationSelector`; account uses imperative selects and sends names rather than IDs.
- API `/profile` trusts client-provided city/zone names and does not visibly re-resolve IDs from delivery-location tables.

Target: one profile read/write contract should serve modal, cart, account, and checkout autofill.

### 6. Admin and customer auth should remain separate planes

Do not merge storefront customer auth into Better Auth by default. Admin auth has different threat model, RBAC/2FA requirements, cookie names, and session duration. Keep:

- Admin: Better Auth session in D1, API admin middleware, RBAC, 2FA, cookie forwarding/propagation.
- Customer: OTP, customer sessions, profile/address, order history scoped by `customerId`.

The unifying layer should be D1 durability and service-binding propagation, not one auth library for both audiences.

## Simplified target architecture

### Data ownership

Use D1 as source of truth:

- `customers`: identity and default profile.
- `customer_sessions`: opaque session token hash, `customerId`, `createdAt`, `expiresAt`, `revokedAt`, optional user-agent/IP metadata.
- `customer_auth_challenges`: challenge id, purpose, intent, channel, normalized identifier hash/mask, pinned contact fields, code hash, encrypted delivery code if needed, attempts, expiresAt, consumedAt, cancelledAt.
- `auth_otp_delivery_receipts`: keep the current receipt table and claim model.
- `customer_addresses` if multiple saved addresses are desired; otherwise keep the current single-address columns but validate/resolve them server-side.

Use KV only for:

- Public/API/storefront cache.
- Non-authoritative cooldown hints, with D1 enforcing hard limits.
- Optional short TTL read-through cache for session/profile after D1 validates, but never as the only revocation source.
- `cs_auth` remains a cookie hint, not KV data.

Use Queues only for:

- OTP delivery side effects.
- Notification side effects.
- Retryable external-provider calls.

Use Durable Objects only if needed:

- Per-identifier OTP throttling needs strict global serialization beyond D1 CAS/unique indexes.
- A future real-time account/session notification feature needs coordinated state.

### OTP target flow

```text
POST /customer-auth/send-otp
  validate policy, intent, contacts
  D1 transaction/CAS:
    enforce hard rate limits
    create challenge with code hash and pinned contacts
    create or initialize delivery receipt
  enqueue AUTH_OTP_QUEUE with challengeId and deliveryKey, no raw code
  return { queued: true, retryAfter? }

AUTH_OTP_QUEUE consumer
  claim auth_otp_delivery_receipts row
  read challenge from D1
  if expired/cancelled/consumed: mark skipped and ack
  send via Email/SMS/WhatsApp with provider idempotency key
  mark accepted or failed
  ack or retry

POST /customer-auth/verify-otp
  D1 CAS:
    challenge exists, unexpired, unconsumed, attempts < max
    compare code hash
    increment attempts or consume challenge
    create/sign in customer according to pinned intent/contact fields
    create D1 customer_session row
  set HttpOnly cs_tok and readable cs_auth
```

### Session target flow

```text
GET /customer-auth/me
  read cs_tok
  hash token
  D1 lookup active customer_session joined to customers/default address
  return authenticated false or identity + profile/address
  Cache-Control: private, no-store

POST /customer-auth/logout
  clear cookies first
  D1 revoke current customer_session
  optional best-effort KV read-through cache delete
```

Session token storage should use token hashes, not raw tokens. If a read-through KV cache is added later, cache a short-lived session summary keyed by token hash and treat D1 `revokedAt` as authoritative before private reads.

### Storefront anti-flicker target

Use a small state machine across header/cart/account/modal:

```text
unknown
  if no cs_auth hint -> guest
  if cs_auth hint -> optimistic-auth

optimistic-auth
  render stable account skeleton or account affordance
  call /api/customer-auth/me with no-store
  if valid -> authenticated(profile)
  if invalid -> guest and clear cs_auth

authenticated(profile)
  fill header/cart/account from profile
  broadcast same-tab and cross-tab login event

guest
  show sign-in affordance
```

Important UX rules:

- On public pages, use `cs_auth` to avoid flicker, then verify in the background.
- On account/order pages, if `cs_auth` is absent, show the unauthenticated CTA immediately. If present, show a stable account skeleton until `/me` confirms.
- Do not defer `/me` until `load` on pages where auth state changes the primary workflow, such as account and cart. Deferring is fine for a global modal that is not yet open.
- Add `BroadcastChannel("scalius_customer_auth")` or equivalent storage event fallback so logout/login in one tab updates other tabs. Current `customer-login`/`customer-logout` events are same-window only.
- Never store PII in `localStorage`/`sessionStorage`. The current cleanup of legacy analytics PII keys in `apps/storefront/src/lib/checkout/session-state.ts:6` should remain.

### Profile/address target

Make one contract drive modal, cart, account, and checkout autofill:

```ts
type CustomerProfile = {
  customerId: string;
  name: string;
  phone: string;
  email?: string | null;
  defaultAddress?: {
    address: string;
    cityId: string;
    cityName: string;
    zoneId: string;
    zoneName: string;
    areaId?: string | null;
    areaName?: string | null;
  } | null;
};
```

Implementation direction:

- Extend `/me` or add `/profile` GET to read D1 customer profile/address, not only KV session fields.
- Make `/profile` PUT accept IDs and resolve names server-side from delivery locations; reject invalid city/zone/area combinations.
- Reuse the React `LocationSelector` on account page instead of maintaining imperative select code.
- Include optional area consistently. Modal currently hides area during profile setup; cart supports area.
- Keep phone read-only in customer self-service unless a dedicated re-verification flow exists.
- Store checkout delivery details from the selected profile but allow one-off edits before order placement.

## Risks and mitigations

| Risk | Current evidence | Mitigation |
|------|------------------|------------|
| KV stale read rejects a valid OTP or keeps a logged-out session alive | OTP/session KV source of truth in `customer-auth.service.ts:497` and `:668`; Cloudflare KV eventual consistency docs | Move OTP challenges and sessions to D1; use KV only as hint/cache |
| Queue duplicate sends OTP twice | Queues are at-least-once; current consumer has D1 receipt claims | Keep receipt claims and provider idempotency; add tests for stale claim reclaim and terminal skip |
| Raw OTP code persists in queue/DLQ | Queue payload includes `code`; auth-otp DLQ configured | Remove raw code from queue payload; consumer reads challenge and skips expired/cancelled |
| `cs_auth` spoofed | Header/cart read `document.cookie` | Treat as UI hint only; all private APIs use server session lookup |
| Profile update stores mismatched names/IDs | Modal sends IDs + names; account sends names as values | Server resolves location IDs and names; unify location component |
| Cart autofill misses saved address after reload | `/me` returns session identity only | `/me` or `/profile` should include D1 default address |
| Private account data accidentally cached | Storefront cache policy checks private cookies; API no-store on customer endpoints | Keep no-store tests; add storefront cache tests for pages with `cs_tok`/`cs_auth` |
| Admin cookie refresh lost through service binding | `api.server.ts` propagates API `Set-Cookie` | Keep existing tests and add coverage for split multiple cookies |
| D1 read latency on global storefront | D1 primary reads may be remote | Use D1 Sessions API/read replication for read-heavy profile/order reads if enabled; keep writes on primary |

## Existing useful tests

- API customer private no-store and order scoping: `apps/api/src/routes/customer-auth-cache.test.ts:202`, `apps/api/src/routes/customer-auth-cache.test.ts:305`.
- Queue handoff failure clears OTP KV: `apps/api/src/routes/customer-auth-cache.test.ts:378`.
- Customer auth intent, duplicate contact, pinned contact, channel-scoped OTP: `packages/core/src/modules/customers/customer-auth.service.test.ts:56`.
- OTP transport metadata and no WhatsApp secrets in queue payload: `packages/core/src/modules/customers/otp-transport.test.ts:12`.
- OTP delivery receipt hashing/masking/idempotency helpers: `packages/core/src/modules/customers/otp-delivery-receipts.test.ts:10`.
- Queue consumer OTP dispatch, failed provider retry, deterministic SMS refs, WhatsApp refs, expired OTP skip: `apps/api/src/queue-consumer.test.ts:524`.
- Admin cookie forwarding and `Set-Cookie` propagation: `apps/admin-v2/src/lib/api.server.test.ts:34`.
- Admin direct D1 session lookup: `apps/admin-v2/src/lib/admin-session.server.test.ts:28`.
- Storefront customer auth UI policy: `apps/storefront/src/lib/customer-auth-ui.test.ts:8`.

## Recommended tests to add before/with changes

Backend:

- `send-otp` creates a D1 challenge and enqueues only `challengeId`/`deliveryKey`, never the OTP code.
- Queue consumer skips expired, consumed, cancelled, or missing D1 challenges and marks receipt skipped.
- Verify OTP consumes a challenge with a CAS/update predicate and cannot be replayed by a second request.
- Failed verify increments attempts atomically and locks out after max attempts.
- Logout revokes D1 `customer_sessions`; stale `cs_auth=1` plus revoked/missing `cs_tok` returns `{ authenticated: false }`.
- `/me` returns profile/address from D1 and still has private no-store headers.
- `/profile` rejects invalid city/zone/area combinations and resolves display names server-side.

Storefront:

- Header/account affordance uses `cs_auth` only as optimistic state and falls back to guest when `/me` returns unauthenticated.
- Cart autofills name, phone, email, address, city, zone, and area from `/me`/profile after a full reload.
- Account page distinguishes unauthenticated, loading, empty orders, and API error states.
- Login/logout updates header/cart/account in the same tab and another tab.
- Account profile editor and cart checkout use the same location-selector behavior.

Integration/E2E:

- Sign up with email OTP plus required phone, complete profile, reload cart, confirm address autofill.
- Sign in with phone/SMS or WhatsApp when enabled, verify duplicate sign-up is rejected before challenge creation.
- Queue retry of an OTP delivery does not double-send when receipt is accepted.
- DLQ payload inspection test asserts no raw OTP code is present.
- Admin sign-in/2FA/session-refresh still forwards cookies through admin-v2 to API.

## Migration path

1. Add D1 tables and keep old KV paths working behind a compatibility branch.
2. Move `/me` and private order/profile auth checks to D1 sessions while still accepting existing KV sessions until they expire.
3. Move OTP challenges to D1 and keep the current D1 receipt claim model.
4. Remove raw OTP code from queue payloads.
5. Expand `/me` or add `/profile` GET for profile/address.
6. Unify storefront account/cart/modal profile components around one profile/address contract.
7. After the 30-day legacy KV session TTL passes, delete KV authoritative session code.

## Final recommendation

Adopt D1 as the customer auth source of truth, keep Queues for side effects, keep the storefront same-origin proxy, and demote KV to caching/hints. This keeps the architecture Cloudflare-native while matching each product's documented consistency model: D1 for durable identity/session/challenge state, Queues for retryable delivery, Service Bindings for internal Worker calls, KV for cache-like data, and Durable Objects only for future strict per-identifier coordination if D1 CAS is not enough.
