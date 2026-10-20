# Sellers: platform burst notes (Oct 20)

What the marketplace reference app (`scalius.sellers`) still needs from the
platform. The full gap list is `audit/burst-notes/bazaar-sellers-gaps.md`.

## Done in this burst

1. **CSRF for app proxy forms.** The storefront gateway puts a hidden
   `_scalius_form` token (HMAC of the app id and the buyer's session, key
   derived from `SCALIUS_SECRET`) in every `<form method="post">` aimed at
   `/apps/<id>/...` on pages rendered for a signed-in buyer, after the page
   cache. The API refuses a session-carrying form, multipart or text post
   without a valid token before the app runs (403 `FORM_EXPIRED`, or a
   "Reload the page" page for a plain navigation) and strips the field from
   `body`. Works without JavaScript; JSON requests need none.
   Code: `packages/shared/src/plugins/app-form.ts`,
   `apps/storefront/src/lib/app-form-tokens.ts`, `apps/api/src/plugins/routes.ts`.
2. **Route list for app pages.** `request.routes` on public routes: `home`,
   `search`, `cart`, `account`, `signIn`, `orders`, `trackOrder`, from
   `@scalius/shared/storefront-routes` (the header skin data reads the same
   list). Root paths: the gateway keeps links and redirects inside a market
   presence, and the forms enhancer now follows `navigate`/`redirect` through
   `pagePath()`. The portal links guests to `routes.signIn`.
3. **Email idempotency key.** `ctx.messaging.email({ idempotencyKey })`
   sends at most once per app and key in 24 hours (a `system_kv` claim; a
   failed send releases it; a claim from a run that died mid-send expires
   after two minutes, so the retry sends). Answers `duplicate: true` on a
   repeat. The order-split notice uses a per-split key on every delivery.

## Left (exact next steps)

### App-scoped customer roles (design, not built)

- Table `plugin_customer_roles` in migration **0166** (0163 to 0165 are
  taken): `plugin_id`, `customer_id` (FK `customers.id` ON DELETE CASCADE),
  `role` (`^[a-z][a-z0-9_-]{0,31}$`), `ref` (nullable, at most 128 printable
  characters, the app's own record id), `granted_at`; primary key
  `(plugin_id, customer_id, role)`. Exempt in `CACHE_DEP_EXEMPT_TABLES` as
  PRIVATE (no public read). Add the 0166 SQL and PostgreSQL sidecars,
  `schema-contract.ts`, the schema-hygiene table count and the
  schema-upgrade test rows. The metadata check requires contiguous versions,
  so this lands after 0163 to 0165.
- Bridge: `customerRolesGrant(customerId, role, ref?)`,
  `customerRolesRevoke(customerId, role)`, `customerRolesList(customerId)`,
  scoped to the calling app, refusing a missing or deleted customer, at most
  10 roles per app and customer. Add them to `bridge.ts`,
  `bridge-entrypoint.ts`, `loaders/bundled.ts` (method list),
  `plugin-sdk/src/runtime.ts` (`ctx.customers.roles`, optional on older
  hosts), the harness, and regenerate `sandbox-runtime.gen.ts`
  (`pnpm plugin build`) and the ABI snapshot.
- `request.customer.roles: Array<{ role, ref }>` on proxied requests: read in
  `proxiedCustomer()` (routes.ts) right after the session, this app's rows
  only (one primary-key-prefix read).
- `uninstallPlugin` with `keepData: false` deletes the app's rows.
- Cart functions do not see roles yet: the function cart is shared by every
  app. Adding them needs a per-app projection in the runner.
- Sellers then: `createSeller`/`setSellerStatus` grant `seller` (ref = seller
  id) on approval and revoke it on suspension or rejection, and
  `portalRoute` gates on `request.customer.roles` instead of
  `sellerOfCustomer()`.

### Sellers manage their own products (design, not built)

The stable `dashboard.resources.products.create` and `.update` are enough;
no platform change is needed for the minimum. In the portal's Products tab:

- A "New product" form (name, description, price in major units, condition)
  posts to `portal/products`; the handler, for an approved seller only,
  calls `products.create` with `status: "draft"`, one variant
  (`sku: <seller handle>-<random>`, `priceMinor`), and
  `idempotencyKey: sellers-product-<seller id>-<form nonce>`; then
  `assignProduct()` records the seller. Staff publish (status `active`).
- An "Edit" form per owned product posts `portal/products/<id>`: the handler
  checks `product_sellers/<id>.seller_id` is this seller, reads the product
  (`products.get`) for `revision`, and calls `products.update` with
  `expectedRevision`, never `status`.
- Wanted later from the platform: audit attribution "on behalf of customer
  X" in `ctx.api.call` (an `onBehalfOf` input the audit row records), and a
  bulk product read for the Products tab (gap 19).

### Post-beta

- **Offers model** (gap 10): several sellers per product, each with its own
  price, stock pool and fulfilment, priced through `resolvePrice()`, the buy
  form choosing an offer, the order line carrying `offerId`. Touches ledger
  v2 and checkout: a core design item.
- **Payouts provider** (gap 18): a `payout` provider port (`createTransfer`,
  `transferStatus`), idempotent on the payout id. Payouts stay records that
  staff approve and mark paid until then.

## Unverified

- No real store run: the gateway token rewriter is tested with a fake
  rewriter only (`app-form-tokens.test.ts`), not in workerd or a browser.
  The no-JavaScript post of the Sellers apply and ship forms with a token was
  not exercised end to end.
- A signed-in buyer who submits a form from a page loaded before they signed
  in (no token) gets the "Reload the page" answer; by design, untested in a
  browser.
- The email key path ran against the bridge test's sqlite only; the
  PostgreSQL provider's `ON CONFLICT ... WHERE` on `system_kv` was not run.
- `pnpm plugin build` also rewrites `assets.gen.ts` and `catalog.gen.ts` to
  add bazaar, sellers and volt: drift that was already on the lead, left out
  of these commits.
- `node scripts/check-source-policies.mjs` fails on the lead already
  (`apps/api/src/agent-access/eval/seed.ts`, `fulfilled_quantity`), unrelated.
