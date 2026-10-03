# Markets, money, channels, addresses, tax and translations

Status: design, 2026-10-03, wave 6. Owner: lead. Research behind every
decision: Shopify (Markets, MoneyBag, OrderTransaction, Catalogs,
Publications, Worldwide), Medusa v2 (Pricing Module, Region, Sales Channel,
Tax Module, Translation), Vendure (Channel, per-currency prices, zones,
Translatable), Saleor (channels, address validation rules), Stripe
(presentment/settlement, FX Quotes). We copy their converged answers and the
lessons they paid for. Nothing here changes behaviour for today's
single-currency Bangladesh store: step 1 ships as no-ops, step 2 adds one
default market equal to the current store.

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
- The rate is locked when checkout prices the cart (lock TTL from the market,
  default 30 minutes); an expired lock re-prices before commit.

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
- **Resolution on the server**, deterministic: explicit buyer choice (cookie)
  > cart shipping country > URL presence > geo hint (`cf-ipcountry`) >
  backup. Crawlers are never geo-redirected; EU-safe: no forced redirects.
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
    `price_lists` (id, kind `market` | `segment` | `sale`, market_id,
    segment_id, starts_at, ends_at, priority, status) and `price_list_prices`
    (price_list_id, variant_id, currency_code, amount_minor,
    compare_at_minor, min_quantity), or
  - **FX-derived prices**: base × market rate (manual override or the rate
    source), then the market's price increment and ending (e.g. `.95`,
    whole taka), with optional percentage adjustment (Shopify catalogs).
    Computed at read with the rate as a cache dependency; no stored copies.
- Precedence, documented once: active sale list > segment list > market list
  > FX-derived > base; among equals, higher priority, then lowest amount.
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

## Sequence (each step ships, deploys and stays behaviour-identical for BDT)

1. Currency policy, gateway amount codec, order FX snapshot columns,
   payment settlement columns, whole-taka moved to market/payment policy.
2. `markets` with one backup market mirroring today's store; resolution;
   URL presences; DVC dimensions; per-market feeds/sitemaps.
3. Country-aware addresses with the BD adapter; tax regions and the system
   tax provider; `prices_include_tax` per market.
4. Price lists (fixed per market/segment/sale), FX-derived pricing with
   rounding policy; translations, localised slugs, hreflang.
5. Sales channels, publications and channel stock locations.
6. Only then enable a second currency: fixed prices first, FX generation
   later. Payment methods gated by `chargeCurrencies`.

## Step 1 implemented

Behaviour is unchanged for a BDT store: prices stay whole taka, COD collects
whole taka, and every order is same-currency.

**Currency policy** (`packages/shared/src/currency-policy.ts`).
`SUPPORTED_CURRENCY_CODES` (156 codes) moved here. `EXCLUDED_CURRENCY_CODES`
is `["CLF", "UYW"]`. A table gives each code `[exponent, cashIncrementMinor,
displayDigits]`, read through `currencyPolicy()` and `currencyExponent()`.
`getDecimalPlaces()` (`currency.ts`) is `currencyExponent()`. The CLDR cash
increment and display digits are recorded but not used yet.

**Price increment** (D1). `PricingCurrency` is `{ code, decimalPlaces,
priceIncrementMinor }`. Defaults: `defaultPriceIncrementMinor()` is 100 for
BDT and 1 otherwise; `priceIncrementChoices()` is the minor unit or the whole
unit. Until step 2 it is stored as `priceIncrementMinor` in the `currency`
settings document (`priceIncrementOf()`, `readStoreCurrency()`,
`storePriceIncrementSql()`), edited in Settings → Store details, and served to
the dashboard (`useCurrency()`) and the storefront
(`window.__CURRENCY_PRICE_INCREMENT__`, the layout `currency` block). A change
queues a catalogue projection rebuild. `money.ts` replaces the BDT cash
helpers with `toIncrementMinor()`, `roundToIncrementMinor()`,
`floorToIncrementMinor()`, `percentOfMinor()`, `discountedPriceMinor(..., inc)`,
`PriceIncrementError` and `priceIncrementMessage()`. Catalogue and SQL-twin
prices, cart validation, bundles, promotions (`promotionAmountIssues()`),
app discounts, tax, EMI, feeds, delivery fees, manual orders, refunds,
custom-field prices and store import all price at the increment. The
dashboard `MoneyInput` resolves "Taka amounts are whole numbers" from it.

**Cash increment** (D1, D2). `cashOnDeliveryIncrementMinor()` is 100 for BDT
and 1 otherwise. `toCashOnDeliveryMinor()` parses cash entered for COD
collection; `MoneyInput` takes `cashOnDelivery` for those fields.

**Order money chain** (D3). Migration `0111_order_money_chain` (D1/Turso file,
PostgreSQL sidecar, ledger digest, schema contract 111) adds to `orders`:
`shop_currency`, `fx_rate`, `fx_source`, `fx_as_of`, `fx_locked_until`,
`subtotal_shop_minor`, `shipping_shop_minor`, `discount_shop_minor`,
`tax_shop_minor`, `total_shop_minor`; existing rows are backfilled
same-currency. `@scalius/shared/money-chain` holds `SAME_CURRENCY_FX_RATE`
("1"), `SAME_CURRENCY_FX_SOURCE` ("same_currency"), `convertMinorAtRate()`
(exact decimal rate, half-up), `orderMoneyChainColumns()` and
`orderShopAmounts()`. The checkout commit and `createOrder()` write the chain
in the order insert; an amendment rewrites the shop amounts. Dashboard
revenue sums `total_shop_minor`; reports read only orders whose
`currency_code` and `shop_currency` are the report currency.

**Settlement** (D2). The same migration adds `settlement_currency`,
`settlement_amount_minor`, `settlement_rate` and `exchange_adjustment_minor`
to `order_payments`. `paymentSettlement()` records a provider's report (the
payment event's `settlement`); the adjustment is measured against the order's
locked rate when it settled in the shop currency. Every other row uses
`presentedSettlement()`. Refunds stay in the presentment currency.

**Amount codec** (D2). `PaymentProviders.encodeAmount()` and `amountIssue()`
serve every path: gateway `amountCodecs`, and `cashOnDeliveryAmountCodecs()`
for COD. A non-zero rounding is refused before the commit or the provider
call (`precommitIssue()`, session creation, refunds, storefront COD with
reason `cash_on_delivery_amount`, staff COD quotes), so the charge equals
the stored amount. Stripe declares `STRIPE_AMOUNT_CODECS` and decodes what it
reports with `decodeProviderAmount()`.

**DVC.** No new buyer-visible column: `orders` and `order_payments` are
private, and the increment lives in the `currency` document, which its
settings dependency already covers.

**Left for later steps.** Checkout locks no FX quote yet (`fx_as_of` and
`fx_locked_until` stay null). No built-in adapter reports settlement (Stripe
needs the balance transaction). `customer_order_stats`, order lines and
report measures hold presentment amounts; they move to shop amounts before a
second currency is enabled (step 6).

## Non-goals in this wave

Duties calculation, merchant-of-record, B2B company locations (later through
segments and price lists), multi-vendor sellers, per-channel stock counts.
