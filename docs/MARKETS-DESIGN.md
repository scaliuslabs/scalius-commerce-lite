# Markets, money, channels, addresses, tax and translations

Design record for markets, money, channels, addresses, tax and translations (2026-10). The
decisions D1 to D9 copy the converged answers of Shopify (Markets, MoneyBag, Catalogs,
Publications), Medusa v2, Vendure, Saleor and Stripe, and the lessons they paid for. Every step
shipped behaviour-identical for a single-currency Bangladesh store. The code, its tests and the
rules under `rules/markets/`, `rules/money/`, `rules/shipping/`, `rules/tax/` and
`rules/translations/` are the detail; code comments cite the decisions (D1 to D9) and steps below.

## Vocabulary (fixed before any public API ships)

- **Market**: a configuration bundle a buyer is matched to: countries,
  currency, languages, URL presence, price lists, tax inclusivity, delivery
  and payment methods, product availability. Not a tenant, not "one country,
  one currency".
- **Sales channel**: where products are published (online store, POS,
  Facebook/Instagram catalog, Google, agents/UCP, plugin marketplaces), with
  optional stock locations. Never per-channel stock counts.
- **Order channel** (`orders.channel` + `channel_source`): attribution of the
  surface that created the order. Unchanged.
- **Seller** (later, plugin or core): multi-vendor. Never modelled as a
  channel (Vendure's lesson).

## D1. Money

- Every money value stays `{ amountMinor: integer, currencyCode }`. Integers
  suit D1/SQLite/PostgreSQL alike and match PSP wire formats. No global
  precision (Vendure), no fixed 2 dp contract (Shopify AJAX), no unrounded
  intermediates (Medusa #13734/#14818): every allocated amount is a whole
  minor unit, allocation keeps the existing largest-remainder rule.
- `@scalius/shared/currency-policy`: one table per currency with the three
  separate facts: ISO storage exponent, cash increment (CLDR: CHF 5, CAD 5,
  DKK 50; zero-cash-digit currencies), display digits. Currencies with
  exponent 4 (CLF, UYW) are excluded explicitly from `SUPPORTED_CURRENCY_CODES`.
- Whole-taka is not a currency fact (CLDR has none for BDT). It becomes two
  explicit policies: a market **price increment** (merchant-entered prices in
  a BDT market are whole taka) and a payment-method **cash increment** (COD in
  BDT collects whole taka). `cashRoundingMinor("BDT")` callers move to these.
- The HTTP contract keeps decimal major units converted once at the edge, but
  always with the order's/market's currency exponent, never a constant.

## D2. Payment amounts and settlement

- Each payment provider (the provider port from plugin phase 3) declares
  `chargeCurrencies` and owns an **amount codec**: minor units → wire amount
  (Stripe ISK/UGX `00`, three-decimal last digit `0`, Adyen IDR), returning the
  wire amount and any rounding difference, which is recorded, never silently
  added (Medusa ceils it).
- A payment method that cannot charge the market currency is either hidden
  for that market or charges the shop currency with the checkout stating the
  charged amount (Shopify's display-only trap made explicit). COD charges
  BDT only.
- Payment transactions store `settlement_currency`, `settlement_amount_minor`,
  `settlement_rate`, and `exchange_adjustment_minor` (Shopify's
  `currencyExchangeAdjustment`). Refunds are always in the presentment
  currency; the FX difference is merchant P&L on its own line.

## D3. Order money chain

- `orders.currency` is the **presentment** currency: the buyer's truth, what
  line, discount, tax, shipping and totals are in.
- New snapshot columns: `shop_currency`, `fx_rate` (decimal string),
  `fx_source`, `fx_as_of`, `fx_locked_until`, and shop-currency totals
  (`subtotal_shop_minor`, `total_shop_minor`, `tax_shop_minor`,
  `shipping_shop_minor`, `discount_shop_minor`) for reporting. For a
  same-currency order the rate is `1` and the shop amounts equal the
  presentment amounts. Analytics sum shop amounts; nothing ever sums mixed
  currencies.
- Placement permanently freezes the order rate and amounts. The market lock (default 30 minutes)
  is the deadline to start a new buyer payment session on a wholly unpaid foreign-currency order;
  it never reprices a placed order. Existing sessions and partly-paid balances remain valid.

## D4. Market

Tables (sketch): `markets` (id, handle, name, status, `is_backup`,
`currency_code`, `price_mode` = `fixed` | `fx`, `fx_rate_override`,
`price_increment_minor`, `price_ending`, `prices_include_tax`,
`default_locale`, `locales` JSON, `fx_lock_minutes`, revision),
`market_countries` (country_code primary key → one market per country),
`market_presences` (market_id, kind = `subfolder` | `domain`, value, locale)
and links from markets to delivery methods and payment methods.

- Exactly one **backup market** (Shopify's 2025-04 model) used when no signal
  matches. Migration creates it from today's store: BDT, `bn`/`en`, BD,
  prices include tax as today.
- **Resolution on the server**, deterministic. The URL presence decides the
  page (the root is the backup market), so a URL is cacheable and
  Google-safe. An explicit buyer choice (cookie) may redirect a top-level
  navigation to the same path under its presence. Geo (`cf-ipcountry`) is
  only a suggestion. At checkout the shipping country decides the order's
  market. Crawlers are never redirected; EU-safe: no forced redirects.
- One URL per locale × market (subfolders by default, `/en-us/...`); never
  locale-adaptive content on one URL (Google's guidance).
- **DVC**: market, currency, locale and price-list identity are dimensions
  of every public read key and dependency (`deps.market`, `deps.priceList`,
  `deps.fxRate`, `deps.translation`), or a BDT price reaches a USD buyer.
  Feeds, sitemaps and robots become per market presence and keep failing
  closed on non-absolute URLs.

## D5. Prices

- Base prices stay on `product_variants` in the shop currency (the backup
  market). Other markets use:
  - **fixed prices** (first-class, Medusa/Vendure/Saleor):
    `price_lists` (id, kind `market` | `segment` | `sale` | `override`, market_id,
    segment_id, starts_at, ends_at, priority, status) and `price_list_prices`
    (price_list_id, variant_id, currency_code, amount_minor,
    compare_at_minor, min_quantity), or
  - **FX-derived prices**: base × market rate (manual override or the rate
    source), then the market's price increment and ending (e.g. `.95`,
    whole taka), with optional percentage adjustment (Shopify catalogs).
    Computed at read with the rate as a cache dependency; no stored copies.
- Precedence, documented once: purchase-option app > override; otherwise a sale
  only lowers segment > market list > app > FX-derived > base. Among lists of
  one kind, higher priority wins, then lowest amount; sales choose the lowest
  rounded amount first.
- Compare-at lives on the same row; a `prior_price` field can be added for
  Omnibus-style rules later (Saleor keeps it manual, so do we).
- Quantity breaks are `min_quantity` rows (Medusa), not a separate system.

## D6. Sales channels

`sales_channels` (id, handle, kind: `online_store` | `pos` | `catalog_feed` |
`agent` | `app`, plugin_id, status) with a default online store channel;
`product_channel_publications` (product_id, channel_id, published_at,
unpublished_at); `sales_channel_locations` (channel_id, location_id) for
availability. Feeds, UCP and POS read their channel's publications. Orders get
`sales_channel_id` next to the attribution `channel`.

## D7. Addresses

- Canonical structured columns on order and customer addresses:
  `country_code`, `admin_area` (state/division/emirate), `locality`
  (city/district), `dependent_locality`, `postal_code`, `line1`, `line2`,
  `name`, `company`, `phone_e164` (+ raw input), `validation_skipped`.
- Country rules come from libaddressinput/CLDR metadata kept outside the
  schema (Saleor's `addressValidationRules` shape: allowed and required
  fields, postal regex, examples, labels, field order), served per country
  and cached; forms render from them.
- Bangladesh keeps its courier-grade **adapter**: `city`/`zone`/`area` IDs
  and names (delivery locations) alongside the canonical text fields, because
  couriers need the IDs. The adapter fills `country_code = BD`, `locality`,
  `dependent_locality` from the picked names.
- Add `country_code` before the first foreign order: migrations backfill BD.

## D8. Tax

- `prices_include_tax` per market. Persisted tax lines per order line
  (already `order_item_tax_snapshots`) gain jurisdiction, provider id and the
  inclusive flag.
- Tax provider port (from the provider ports): `calculate` → `commit` →
  `void`/`refund`, idempotent; the built-in **system provider** handles
  flat/manual rates by tax region (`country_code`, `admin_area`, parent),
  with Bangladesh city/zone/area as one jurisdiction type of it.
- Zero tax where the merchant has no registration (Stripe Tax's rule).
- Duties and import taxes are separate lines from a provider, never coded
  rules (de minimis changes yearly). Not in this wave.

## D9. Translations

- One table: `translations` (resource_type, resource_id, locale, market_id
  nullable, fields JSON, source_digest, updated_at), unique per
  (resource_type, resource_id, locale, market_id). The source digest marks a
  translation stale when the source text changes (Shopify).
- Fallback chain: market locale → store default locale → source value
  (Vendure). Localised slugs in `localized_slugs` (resource_type, locale,
  slug) unique per locale.
- Translatable: products, variants, options and values, collections,
  categories, brands, pages, navigation, delivery and payment method names,
  policies, email/SMS/invoice templates.
- hreflang (reciprocal, self-referencing, `x-default`) generated from the
  published locale × market matrix; per-locale sitemaps.

## Sequence

Each step shipped, deployed and stayed behaviour-identical for a BDT-only store: same bytes, same D1
calls and statements in every budget.

1. Currency policy, gateway amount codec, order FX snapshot and payment settlement columns,
   whole-taka moved to market and payment policy.
2. Markets with one backup market mirroring the store; resolution; URL presences; cache dimensions;
   per-presence feeds and sitemaps.
3. Country-aware addresses (3a), shipping zones (3b), tax regions and the tax provider port (3c).
4. Price lists and FX-derived prices (4a); translations, localized slugs, hreflang (4b).
5. Sales channels, publications and channel stock locations.
6. A second currency.

## Step 1 implemented

`@scalius/shared/currency-policy` holds each currency's exponent, cash increment and display digits.
The price increment (a market fact) and the cash increment (a payment-method fact) replaced the old
whole-taka rounding. Orders carry the money chain (D3) and payments their settlement (D2); gateways
convert through their amount codec.

## Step 2 implemented

Markets (migration 0112) with one backup market. `resolveMarket()` (`@scalius/shared/markets`) is the
one resolution: the URL presence decides the page (the root is the backup market), a buyer's explicit
choice may redirect a top-level navigation (never a crawler, fetch, prefetch, POST or discovery file),
geo is only a dismissible suggestion, and at checkout the shipping country decides the order's market.
One route tree serves every presence; the gateway rewrites links and caches the presence page under its
own key. Hreflang, the selector and the suggestion appear only with two or more presences.

## Step 3a implemented

Country-aware addresses (migration 0113): canonical structured columns plus the Bangladesh adapter's
place ids. Address rules per country are generated metadata (`pnpm generate:address-metadata`),
served per country. Another country is possible wherever an address is entered and fails closed where
the store cannot serve it.

## Step 3b implemented

Shipping zones (migration 0114, Shopify's model): a zone holds Bangladesh places and regions (a
country, an admin area or a postal prefix). One rule (`zone-match.ts`) picks an address's zone most
specific first; no zone means no delivery rate (fail closed). Local pickup is store-wide. Cash on
delivery serves Bangladesh only. Orders without a phone are allowed only where `orderContactNeeds()`
says so.

## Step 3c implemented

Tax regions (migration 0116, Stripe Tax's rule): a store collects tax only where it has a country
region (its registration); no region means no tax and no provider is asked. Sub-regions match most
specific first, as zones do; combinable rates also apply the broader region's. An addressless order is
taxed at the store's origin. The tax provider port calculates, commits, voids and refunds
idempotently; `prices_include_tax` is per market. Tax-exempt buyers since migration 0178.

## Store setup (G1a)

After the first admin, one guarded batch sets the backup market from the store's country (name,
country, language, price increment) with the shop currency, time zone and units, only while the store
is new. See `docs/STORE-DEFAULTS.md`.

## Billing addresses (0119)

Shopify's rule (`billingAddressNeed()` in `@scalius/shared/billing-address`): an order that ships is
billed at its shipping address; an order that ships nothing asks for a minimal billing address (what
tax regions match on); a pickup order asks for none. Tax follows `taxAddressSource()`: shipping
address, else pickup origin, else billing address, else origin.

## Step 4a implemented

Price lists (migration 0120). `resolvePrice()` in `@scalius/shared/market-pricing` is the one
precedence (D5): a purchase-option app price, then an override list; otherwise a sale applies only when
it lowers the ordinary price (segment list, market list, app price, FX-derived, base). A list price
replaces the SKU price and its catalogue discount; promotions apply after it. FX-derived prices
(`fxPriceMinor()`) are computed at read with the rate as a cache dependency, never stored.

## Step 4b implemented

Translations (migration 0121). `translationChain()` and `resolveTranslatedRecord()` in
`@scalius/shared/translations` are the one fallback; a changed source marks a field Outdated but its
text is still served. The default language is the backup market's root presence locale. Each other
published language is served on the backup market at `/<locale>` with the root's prices; the published
language list is the one source, so no presence row is stored for it.

## Step 5 implemented

Sales channels (migration 0122): one channel per surface (`sc_online_store`, `sc_google`, `sc_meta`,
`sc_agents`, plus app channels), not one feed channel, so a merchant can keep a product off Meta and
on Google. The surfaces read one projection; a channel is a parameter of that read. Publication is the
one truth for feed exclusion. A channel's sellable stock is the stock at its linked locations.

## Step 6 implemented

A second currency (migration 0123). Only the backup market's currency is fixed (the shop currency); a
market selling in its own needs a manual rate and a payment method that charges it. A currency change
re-prices open carts and checkouts (the fence refuses a commit priced before it); placed orders keep
their currency and rate. Every shop-currency amount (delivery fees, promotion amounts, bundle prices,
surcharges, money custom fields) converts at the locked rate and rounds to the market's increment the
same way on every surface, so the buyer pays what the page showed. Cash collection uses the CLDR cash
increment and refuses an amount it cannot collect. Gift cards in another currency convert down, never
paying more than they hold.

## Progressive disclosure (newcomer pass 1)

A store with one market, language, currency, channel set and location sees none of this machinery in
its everyday screens; each control appears when a second of its kind exists. Presentation only: every
API, MCP tool and SDK type is unchanged.

## Non-goals in this wave

Duties calculation, merchant-of-record, B2B company locations (later through segments and price
lists), multi-vendor sellers, per-channel stock counts.
