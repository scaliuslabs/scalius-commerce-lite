# Burst notes: Bazaar theme and Sellers app

Two reference products built on the current plugin platform in one burst:
`plugins/bazaar` (`scalius.bazaar`, a marketplace theme with a demo content
pack) and `plugins/sellers` (`scalius.sellers`, a multi-vendor app). This file
covers both. The platform gaps are the main output; each one names the
contract that was missing and the workaround in use now.

## Verified

- Both plugins: `tsc --build` clean; `pnpm plugin validate` clean; `pnpm plugin pack` clean (the packer smoke-renders every section, block and skin).
- Bazaar: 17 vitest tests. The manifest parses and the handlers match it. The template applies to the default theme as a valid document. Header, footer, card, product page, results page, sections and all four core-section skins render with `storefrontShown(...).dropped === 0`; the header contract holds. Demo import is bounded, idempotent, can retry and tracks each item. Demo removal trashes exactly what the import made.
- Sellers: 11 vitest tests in `index.test.ts` (the run of the 4 storefront block tests was still waiting on the host lock when this file was written). They cover: the manifest and handler match; commission rounding; split status transitions; the product's seller record and public fields; `cart.validate` from the declared read; order splits (one per seller, idempotent on redelivery, the store's own lines left out, one email per seller, one timeline line); split moves; payout drafting (atomic, once, and a settled split survives a later cancel); every admin page and card as a valid UI document; onboarding from the portal (guest, invalid, valid); that a seller can ship only their own split; and that the public seller page shows only while the seller is approved.

## Not verified

- Nothing ran in a real store: no dev server, no browser, no composed journey (`docs/UI-VERIFICATION.md`). Visual fidelity to the reference is unchecked. The CSS was written from the research and never rendered.
- `dashboard.products.create` is a **beta** operation. Bazaar calls it as a bundled first-party app, which may call beta operations. The response shape is guessed (`data.product.id`, then `data.id`). Check it against the real route.
- `dashboard.resources.products.get` `data.revision` is assumed to be the product's `aggregateRevision`, which `dashboard.products.trash` needs.
- In the proxy, the route is assumed to map to `/apps/<id>/<route>/<subpath>`, so `portal/orders` reaches route `portal` with subpath `/orders`.
- Object queries with `where: { payout_id: null }` assume that an absent field matches null in production, as it does in the harness. The harness stores a `null` field as absent; production may differ.
- The bazaar header's department select sends the query to a category listing (`/categories/x?q=...`). Whether a category listing filters by the search parameter is unverified (gap 3).
- `ctx.messaging.email` to a seller's `email` relies on `messaging.recipients` (`sellers.email`). Delivery itself is unverified.
- Neither app is added to `scalius.plugins.json` (`pnpm plugin add` was not run). `pnpm-lock.yaml` gained the two importers from `pnpm install`.
- The Paid sandbox loader is untested. Only the harness was used.

## Platform gaps (contract wanted, workaround now)

### Identity and principals

1. **No seller (or any non-buyer, non-staff) principal.** A seller signs in as an ordinary customer, and the app maps `request.customer.id` to its `sellers.customer_id` index. There is no seller role, no scoped session and no way to give a seller a dashboard login with limited RBAC.
   - Wanted: an app-declared principal, `principals: [{ id: "seller", name, signIn: "customer" }]`. The platform would issue `request.principal = { kind: "seller", id, customerId }` on proxy routes, and the app would grant it to a customer (`ctx.principals.grant("seller", customerId, { ref: sellerId })`).
2. **No CSRF primitive for proxy forms.** The portal's `POST` forms (apply, mark shipped) rely on the platform's cookie SameSite policy. The app cannot see a token.
   - Wanted: `request.csrf` (verified by the platform), or a documented guarantee that proxied POSTs are same-origin-checked before they reach the app.
3. **Proxy pages get no route map.** The portal hard-codes `/account` for sign-in.
   - Wanted: `request.routes = { account, signIn, cart, search, orders }`, the same as `StorefrontHeaderData.routes`.

### Catalogue and theme

4. **No seller-scoped product writes.** Sellers cannot add or edit their own products, so the portal's Products tab is read-only. Staff assign products from a product card instead.
   - Wanted: either a stable `dashboard.products.create/update` an app can call on behalf of a principal with an ownership predicate (`ownerField: "scalius.sellers.seller_id"`), or a "draft product submission" object type that staff publish.
5. **No stable `products.create` for apps.** Demo import depends on the beta operation, which only first-party bundled apps may call. A third-party theme cannot ship a demo pack. `products.create` also has no `idempotencyKey`, so a crash between create and record can duplicate a demo product. The app writes a `pending` record first, which only shows the risk; it does not remove it.
   - Wanted: stable `dashboard.products.create` with `idempotency: "supported"`, and `dashboard.products.lookup_by_slug`.
6. **No way to import an app's own public files into the media library.** Demo photos need an https folder in the settings (`demo_image_base`), because `media.import_url` cannot reach `/_x/<id>/<release>/public/...` from the backend: the release hash is unknown and the origin may be unset.
   - Wanted: `ctx.assets.importToMedia("public/demo/earbuds.jpg")`, or `ctx.plugin.release` plus a documented absolute storefront asset URL.
7. **Card custom fields are opt-in per theme document.** Cards show "by <seller>" only when the theme's `blocks.card.fields` lists `scalius.sellers.seller_name`. A template could set it, but an app cannot add its own field to the card projection of other themes. The core card does not show app fields.
   - Wanted: `customFields[].card: true` (the product card projection always carries the field), or a `product-card` app block slot (gap 9).
8. **Theme token contract forbids the marketplace palette.** `primary` must reach 4.5:1 on `background`, so the yellow "Add to cart" (`#ffd814`) cannot be the brand token. Bazaar uses teal `primary` and hard-codes the yellow and orange pills in its stylesheet. So the store's own buy form buttons (core embed) stay teal, because there is no stable class for "Add to cart" versus "Buy now".
   - Wanted: `tokens.colors.action` / `action-foreground` (a button fill checked against its own foreground, not against the page), plus stable `data-buy-action="add" | "buy"` hooks on the buy form's buttons.
9. **No card or buy-box slot for a second app.** Only one app can skin `product-card`, and product blocks exist only for the product page. With Bazaar's card skin active, Sellers cannot add "Sold by" to cards. Bazaar reads the Sellers fields by name, which couples the two apps.
   - Wanted: `storefront.cardBlocks: [{ type, placement: "card.meta" | "card.badge" }]` rendered inside any skin through a `<CardBlocks />` embed.
10. **No "other sellers / offers" model.** A product has exactly one seller. The marketplace "Other sellers on Amazon" box (several offers per product, each with its own price, stock and seller) cannot be built. Bazaar shows a merchant-set link ("Other sellers") instead.
    - Wanted: an offers primitive. `product_offers` would carry seller, SKU, price, stock pool and fulfilment, priced through `resolvePrice()`, with the buy form choosing an offer and the order line carrying `offerId`. This touches inventory ledger v2 and checkout, so it is a core design item, not an app.
11. **Header projection lacks marketplace facts.** It has no buyer delivery location ("Deliver to <city>"), no account greeting state (signed in or not, first name), no orders route and no language or market switcher data. Bazaar shows a merchant-typed "Deliver to" place and a static "Hello, sign in".
    - Wanted: in `StorefrontHeaderData`, `buyer: { signedIn: boolean } | null` (cache-safe: an attribute the client fills in), `routes.orders`, `markets: [{ label, url }]` and `deliverTo` (the client fills it in from the localization cookie).
12. **Search by department.** The header's department select has no core contract. Bazaar's island points the form at the category URL with the query.
    - Wanted: `routes.search` accepting `category=<id>`, with `StorefrontHeaderData.searchScopes: [{ id, title }]`.
13. **`blocks.navigation.maxTopItems` is capped at 18.** The reference shows about 30 department links. The template uses 18.
14. **The cart page is core-only (R3), so the marketplace cart cannot be replicated.** That cart has save for later, gift options and a right-rail subtotal card. Bazaar styles it only through tokens.
    - Wanted: a declarative cart Buyer UI target (`purchase.cart.line.render-after`, `purchase.cart.summary.render-before`) for "Save for later" and "Gift" lines.
15. **Proxy pages may not get the app's stylesheet.** The portal pages use `sellers-` classes, but the stylesheet is linked "only on pages that show the app's components". Whether a proxy page counts is unverified.
    - Wanted: proxy pages link the app's stylesheet.

### Orders and money

16. **No order split primitive.** Splits live in app Objects, built from `order.created` with one `orders.get` call plus one object read per product (bounded at 30 distinct products per run, within Free's 50 calls a run). Core knows nothing about sub-orders: fulfilment, refunds and returns are order-wide.
    - Wanted: `order.lines[].attribution` (an app-owned tag written at checkout, from `cart.line_prices` or a new `cart.attribution` function point). Then the split is in the order and needs no N+1 read. Also `fulfillment.created` facts carrying `lineIds`, so a partial fulfilment of one seller's lines can move only that split. Today only the whole-order `order.fulfilled` moves splits, plus the portal's own "Mark as shipped".
17. **Partial refunds are invisible to splits.** `order.refunded` facts carry no lines or amounts, so a refunded split is all-or-nothing.
    - Wanted: refund facts with `{ lineId, quantity }[]`. Ids and quantities only, which keeps the no-money event rule.
18. **No payout or transfer rails.** Payouts are records that staff approve and mark paid with a reference. There is no money movement and no payout provider port.
    - Wanted: a `payout` provider port (`createTransfer`, `transferStatus`) beside `payment`, with idempotency on the payout id.
19. **Bulk product reads for apps.** A seller's public page reads products one at a time (`dashboard.resources.products.get`, capped at 12 per page).
    - Wanted: stable `dashboard.resources.products.get_by_ids` (up to 50 ids), or a public storefront product-card read for proxy pages.
20. **Messaging has no idempotency key.** A seller notice sent after the split write can be lost if the handler dies between the two. Sending before the write could duplicate it. The app chose "at most once".
    - Wanted: `ctx.messaging.email({ ..., idempotencyKey })`.
21. **`cart.validate` `onError`.** Sellers uses `skip`, so checkout stays up if the app fails, but then a suspended seller's line can be bought while the function fails. That is the trade-off of the current options.
    - Wanted: a per-function "fail closed only for lines that a declared read names" policy.
22. **Feature-scoped objects.** `demo_items` is base, not part of the `demo_content` feature. Features cannot claim objects.

### Developer experience

23. A new plugin package needs `pnpm install` (lockfile importers) before its tests can run. `pnpm plugin create` should note this.
24. `ui.select` refuses an empty option value, so "none" needs a sentinel (`store`). An explicit `ui.select(..., { allowEmpty: true, emptyLabel })` would be clearer.
25. The harness keeps `harness.sent` as `{ emails, sms, notices, pushes, timeline, ... }`. The README describes it as "recorded messages", so an author can easily guess an array.
26. Section skin fixtures in the packer's smoke render give empty projections (`settings.slides` undefined), although the protocol types them as required. Skins must guard every projection field, so the protocol types should say optional, or the fixtures should be complete.
