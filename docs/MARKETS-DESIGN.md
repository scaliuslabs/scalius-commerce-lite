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
unit. Step 2 moved it to the backup market (see "Step 2 implemented"). It is
served to the dashboard (`useCurrency()`) and the storefront
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

## Step 2 implemented

A store with only the backup market behaves as before: the same URLs, HTML,
feeds, sitemaps, checkout and cache keys. Hreflang, the market selector and
the geo suggestion appear only when two or more presences are active.

**Schema.** Migration `0112_markets` (D1/Turso file, PostgreSQL sidecar,
ledger digest, schema contract 112) adds `markets` (id, handle, name, status
`draft` | `active`, `is_backup`, `price_increment_minor`, `revision`),
`market_countries` (`country_code` primary key: one market per country) and
`market_presences` (market_id, kind `subfolder` | `domain`, value, locale).
The database enforces these rules:

- One backup market (a partial unique index). Triggers refuse to delete it
  or clear its flag (`MARKET_BACKUP_REQUIRED`). It is always active.
- Only the backup market has a price increment (1, 10, 100 or 1000). Other
  markets hold NULL and use it.
- A subfolder value is `''` (the root URL) or `<locale>-<country>`, such as
  `en-in`, and starts with its locale. Only the backup market holds the root
  (`MARKET_ROOT_PRESENCE_BACKUP_ONLY`). The API creates only subfolders;
  `domain` is reserved.
- `orders.market_id` references `markets` (`ON DELETE RESTRICT`). The checkout
  commit and the staff order create set it.

The migration creates `mkt_backup` (handle `bangladesh`, BD, the root URL in
the active checkout language, else `en`). It carries the currency document's
increment to the backup row by the step 1 rule, removes the document field,
and backfills every order. A change of a market's status, increment or
countries advances the checkout authority fence.

**Price increment** (D1). The backup market row is the one source. The
`markets` domain owns `readStoreCurrency()`, `backupPriceIncrementSql()` and
`storePriceIncrementSql()`. Settings → Markets edits it on the backup
market; Store details no longer does. A change queues a catalogue projection
rebuild. A new shop currency resets it to that currency's default
(`resetBackupPriceIncrement()`). The shop currency stays in the `currency`
document, and a market never stores a copy.

**Resolution** (`resolveMarket()` in `@scalius/shared/markets`). One pure
function returns the market, the presence and the reason:

- Page: the URL presence decides (`url_presence`). The root is the backup
  market (`root`). An unknown or draft subfolder answers 404.
- Buyer choice: the selector form posts to `/localization` and works without
  JavaScript. It sets the `localization` cookie (`COUNTRY:presence`) and
  answers 303 to the same page under the chosen presence. The gateway then
  redirects (302, `private, no-store`) a top-level navigation whose cookie
  names another presence. It never redirects a crawler, a fetch, a prefetch,
  a POST or a discovery file. The cookie never bypasses the shared cache.
- Geo: `cf-ipcountry` feeds only a dismissible suggestion
  (`/api/market-suggestion`), never a redirect.
- Checkout: the shipping country decides the order's market
  (`orderMarketId()`; its SQL twin `orderMarketIdSql()` runs inside each
  order insert), else the backup market. Step 3a made addresses
  country-aware.

**Presences and links.** One route tree serves every presence. The gateway
(`apps/storefront/src/worker.ts`, `src/lib/market-presence.ts`) removes the
subfolder, renders the root page with the presence in a gateway-only header,
and localizes the response.

- Decision: response rewriting, not a path helper in every template.
  Reason: merchant menus, rich text, theme sections and app output carry
  root-relative links that no template helper reaches (the gap that
  Shopify's `routes.*` leaves). The HTMLRewriter changes page links in `a`,
  `area`, `form` and `formaction` of presence responses only; a root
  response is not touched. The cache stores the rewritten page, so a hit
  costs nothing. The gateway also localizes the `Location` and feed `Link`
  headers.
- Code that builds a page URL in the browser or in inline script uses the
  same rule: `pagePath()` and `logicalPathname()` (`src/lib/presence-url.ts`)
  or `serverPagePath()`. `presence-links.test.ts` fails on a new
  root-relative page URL in that code.
- Canonical, Open Graph, JSON-LD and breadcrumb URLs of a presence page use
  its presence. Hreflang alternates (reciprocal, self-referencing,
  `x-default` = the backup root) come from the active presence matrix, only
  when two or more presences are active. A presence page has the presence's
  `lang` and `og:locale`. A CMS slug cannot be `localization` or `xx-yy`.

**DVC** (D4). New key kind `mk`: `mk:<market id>` (a market's row, countries
and presences), `mk:*` (the presence matrix) and `mk:backup` (only the backup
market's `price_increment_minor`; every price reader declares it) and `mk:selling`
(the countries the active markets sell to; the checkout config declares it).
`PUBLIC_API_CACHE_ROUTES` gives every public read a `market` field, keyed or
invariant with its reason. This is the one list of market-invariant reads.
Only `/api/v1/checkout/config` is keyed: presence pages add `?presence=`, and
it learns its presence through `publicMarketPresence()`, which refuses an invariant
route. All other reads are invariant today: one catalogue, store-wide
delivery and store-wide text. Step 4 must mark a read keyed before it varies
by market.

**Cost.** A store pays the same D1 calls and statements as before markets:
the free-plan budgets are unchanged. Every market read is a scalar or a join
inside a statement that already runs. The layout's store shape row carries
the matrix (`marketMatrixSql()`, one JSON text). The checkout authority row
carries the backup increment. `readStoreCurrency()` joins the currency
document beside it. The checkout config joins its settings documents to the
presence market (`readPresenceMarketWithDocuments()`). Each order insert
computes its market (`orderMarketIdSql()`).

**Discovery.** Each presence serves its own `sitemap.xml`, child sitemaps,
`/api/product-feed.xml` and `/api/facebook-feed.xml` with presence URLs. The
root `sitemap.xml` also lists the child sitemaps of each active presence.
`robots.txt`, `llms.txt` and UCP stay at the root and serve the backup market.

**Dashboard.** Settings → Markets lists each market with a Backup badge,
status, countries, currency and web presence. A market page edits the name,
handle, status, countries (a country of another market is disabled), web
presence (language and a two-letter country code) and, on the backup market
only, the price increment. Currency is the shop currency, locked until
step 6. A market with orders cannot be deleted; set it to draft. The API is
`dashboard.markets.{list,get,create,update,delete}` under
`/api/v1/admin/settings/markets` with revision checks, and
`storefront.markets.get` serves the active matrix.

**Checkout.** The order records `market_id`.
`GET /api/v1/checkout/config?presence=` reads its market and returns it
(`market`). Delivery and payment methods are still store-wide.

**Left for later steps.** Domain presences. Per-market delivery and payment
methods (steps 3 and 6). Translations and localized slugs: a presence page shows
the store's text under its own `lang` (step 4). The root page keeps the
store's `lang`. Market currencies (step 6).

## Step 3a implemented

A store that sells only to Bangladesh behaves as before: the same checkout
form, payloads, couriers and D1 calls and statements. Another country is
possible wherever an address is entered, and fails closed where the store
cannot serve it yet.

**Rules** (D7). `scripts/generate-address-metadata.mjs` (`pnpm
generate:address-metadata`) writes `packages/shared/src/address-metadata.data.ts`
(252 countries) from Google libaddressinput (Apache-2.0, notice in the file)
at a pinned commit. It merges `RegionDataConstants.java` (format, required
and upper fields, label types), `region_metadata_constants.cc` (postal
examples) and `testdata/countryinfo.txt` (postal pattern, admin areas). It
keeps a postal pattern only when every example matches it, and admin areas
only when the format uses them. `@scalius/shared/address-metadata` (server
only; a source policy refuses it in storefront and dashboard code) gives
Saleor's `addressValidationRules` shape. `@scalius/shared/address` (browser
safe) holds the type, `validatePostalAddress()` and the display formats. The
API serves `GET /api/v1/address-rules` and `/{countryCode}`
(`storefront.address_rules.countries`, `.get`): public cached reads, the same
in every market, no D1.

**Schema.** Migration `0113_country_aware_addresses` (D1/Turso file,
PostgreSQL sidecar, ledger digest, schema contract 113) adds the order
snapshot: `shipping_address_line2`, `shipping_country_code`,
`shipping_dependent_locality`, `shipping_locality`, `shipping_admin_area`,
`shipping_postal_code`, `shipping_company`, `shipping_name` and
`shipping_phone` (null: the order contact), `shipping_validation_skipped`.
`shipping_address` stays the first line. Existing orders with an address are
backfilled BD, with `locality` from the city name and `dependent_locality`
from the thana name; no admin area is invented. It adds the address book
`customer_addresses` (customers README), moves each customer's address into
it as the default (marked `validation_skipped` when incomplete), and drops
the address columns of `customers` and `customer_history`. Billing addresses
are not in this step.

**Triggers.** The shipping address triggers refuse a shipped order without
the fields its country requires: Bangladesh needs City and Thana; another
country needs its required fields unless staff skipped validation. A raw row
without a country counts as Bangladesh (like `market_id`). The bodies are one
statement and the guards are in `WHEN` (remote D1 rule).
`orders_seed_customer_address` gives a new guest record its first address
from its first shipping order. Event triggers: a change to the order snapshot
is `order.updated`; an address-book change is `customer.updated`, except a
record's first address written with the record (`caddr_<customer id>`).

**Checkout.** The countries the active markets sell to are the checkout's
countries (read in the authority statement); others are refused. The address
follows its country's rules; the phone is read in the address country. The
order's market is the shipping country's. Delivery rates serve Bangladesh
only until shipping zones by country (step 3b): another country gets no
delivery rate (`deliveryRatesServeCountry()` is the seam), and pickup still
works.

**Couriers and fraud checkers** state their countries in the provider port
(`countries`: `"any"` or ISO codes). Pathao, Steadfast and the built-in fraud
checkers state `["BD"]`. The order page offers a courier only for an order
shipping to its countries and names the others with the reason; a fraud
check for another country is not sent and says why.

**Dashboard.** The customer page has an address book (add, edit, set as
default, delete); a new customer may get a first address. The staff order
form and the order's edit dialog pick a country and show its fields from the
rules; Bangladesh keeps the City → Thana → Area picker. Staff may save an
address that breaks its rules after the API refused it; it shows "Not
checked". Copy is in English and Bangla.

**Storefront.** The country field shows only when the store sells to two or
more countries. The chosen country's block shows with CSS alone, so checkout
and the account address book work without JavaScript; with it, the rules
hide unused fields, mark required ones, show a postal example and offer the
regions. Another country's delivery says "We don't deliver to {country}
yet". Checkout prefills the account's default address. Account → Profile is
an address book on plain POSTs.

**Agents and MCP.** New registry rows: `dashboard.customers.addresses_*`,
`storefront.customer_addresses.manage` and `storefront.address_rules.*`. Staff
and agent order creation, order edits and customer creation take the
canonical address (`shippingCountryCode` and `shipping*`, or `address`).
The SDK is regenerated.

**DVC.** No buyer-visible column: orders and the address book are private
(`customer_addresses` is exempt with its reason). Address rules are code;
the Worker version in every cache key covers them.

**Cost.** D1 calls and statements are unchanged in every free-plan budget
scenario (29 per plan). An order that seeds an address book writes one more
row (the address); nothing else changes.

**Left for later steps.** Shipping zones and rates by country, and per-market
delivery methods (3b). Tax regions, the system tax provider and
`prices_include_tax` per market (3c). Billing addresses (0119). Address
autocomplete. Quick checkout ("Buy now") and agent buyer contexts keep the
Bangladesh address until 3b. Customer segments by country.

## Step 3b implemented

A store that sells only to Bangladesh behaves as before: the same delivery
rates, fees and free-over amounts for the same City/Thana/Area, the same
feed lines and JSON-LD, and the same D1 calls and statements in every
free-plan budget scenario.

**Zones** (Shopify's model). A shipping zone serves Bangladesh delivery
locations (`delivery_zone_locations`, as before) and regions
(`delivery_zone_regions`): a whole country, one admin area (the address
rules' code) or a postal-code prefix. A region belongs to one zone (primary
key). One rule (`zone-match.ts`, browser safe) picks an address's zone, most
specific first: Bangladesh location (area, thana, city), the longest postal
prefix, the admin area, the whole country. No zone means no delivery rate
(fail closed); local pickup is store-wide and always offered. A country is
served "entire" when one zone holds it whole and no other zone holds part of
it.

**Schema.** Migration `0114_shipping_zones` (D1/Turso file, PostgreSQL
sidecar, ledger digest, schema contract 114) adds `delivery_zone_regions`.
The live delivery rates without a zone ("Everywhere else", which served only
Bangladesh) move to the zone `dz_bd` "Bangladesh" (region BD), with the same
ids. Pickup keeps `zone_id` null; its revision document becomes
`delivery_pickup`. A trigger refuses a live delivery rate without a zone
(`SHIPPING_RATE_ZONE_REQUIRED`). Region writes advance the checkout
authority revision and the `ship` cache dependency. Agent storefront
contexts gain `country_code`, `admin_area` and `postal_code`.

**Checkout.** The rate row statement carries its destination country's
regions, and location rows carry their zone, so a Bangladesh checkout runs
the same statements. Another country's address gets the rates of its zone
(`deliveryRatesServeCountry()` is gone). The tax quote, cart validation,
checkout, quick checkout ("Buy now", also without JavaScript) and agent
buyer contexts take the country, admin area and postal code. The order
keeps them.

**Cash on delivery** has a country rule in the payment provider port:
`countries` (`"any"` by default; COD `["BD"]`). Checkout config, the cart's
methods, the agent quote and order placement hide or refuse a method for a
delivery country it does not serve (`payment_method_unavailable`). Staff
orders keep cash on delivery for any country (staff decide).

**Discovery.** `GET /api/v1/shipping-methods` takes `countryCode`,
`adminArea` and `postalCode`, and states each rate's `countries` (`entire`
or not). Product JSON-LD emits one `shippingDestination` per country the
page's market sells to, only where a zone serves every address there; a
free-delivery product ships free to each country a zone serves. Each
presence's feeds state `<g:shipping>` per country the same way. The feed
row no longer carries a Bangladesh literal.

**Dashboard.** Settings → Shipping and delivery lists zones with their
countries, regions, postal prefixes and rates. A zone picks countries with
the Markets country checklist; per country, all of it or part of it (admin
areas from the address rules and postal prefixes; for Bangladesh the
delivery area picker). Local pickup is its own card. The staff order form
and the shipping policy template use the same rule. Copy is in English and
Bangla.

**Agents and MCP.** `dashboard.shipping_zones.everywhere_else_update` is
replaced by `dashboard.shipping_zones.pickup_update` (`PUT
/api/v1/admin/settings/shipping-methods/pickup`). Zone create and update
take `regions` and `locationIds`. The SDK and agent contract are
regenerated.

**DVC.** `delivery_zone_regions` is registered with dependency `ship`
(later table, migration 0114). The property and race gate reports zero
findings. It also found a stale product page part (`product_buyer_state`
delete): the product page EMI read now joins only public rows.

**Phone countries.** A buyer who ships to a market's country must be able to
give a number from there. The phone countries a store accepts are the merchant's
customer-country policy united with the countries of the active markets
(`acceptedPhoneCountryPolicy()`, `@scalius/shared/customer-utils`): include `L`
accepts `L` and the market countries; exclude `X` refuses `X` without the
market countries; no policy accepts every country. `readAcceptedCustomerCountries()`
(settings) is the one reader for staff orders and customers, customer sign-in
and the customer import; the checkout authority and `GET /api/v1/checkout/config`
(`allowedCountries`) apply it too, so the storefront, the API and the agent
checkout agree. The market countries ride in a statement each read already
runs (`sellingCountriesSql()`), so D1 calls and statements do not change. The
config read therefore declares `mk:selling` beside its market's `mk:<id>`.
`mk:selling` (migration 0115) is the set of countries the active markets sell to:
it advances when a country of an active market is added, moved or removed, when
a market's status changes or an active market is deleted, and never for a
rename, a handle or a presence edit. A rename of one market leaves every other
market's checkout config valid. The
checkout phone field starts in the address form's country when the store
accepts its numbers and follows the buyer's choice, unless the buyer picked the
phone country or typed a number that is valid as it is. Its hint and placeholder
are the country's: Bangladesh keeps the merchant's text, another country asks
for the country code and shows a libphonenumber example (`phone-hint.ts`). A
store that sells only to Bangladesh renders the same phone field, byte for byte.

**Orders without a phone (2026-10-07).** With the Customer accounts opt-in, an
order of only digital or service lines, paid in full online and placed outside
Bangladesh, may go without a phone; e-mail is then required
(`orderContactNeeds()`, `@scalius/shared/customer-auth-policy`). Such an order
has no address, so it sends its market's country as `shippingCountryCode`
(the cart's `orderCountryCode` field, the agent context's country). The API
counts only a country an active market sells to; none means Bangladesh, where a
phone is always required. A store that has not opted in sends nothing new.

**Left for later.** Rate conditions (weight, order value), a "Rest of the
world" zone, carrier-calculated rates, per-market delivery methods, a
country rule for staff cash on delivery, tax regions (3c) and address
autocomplete.

## Step 3c implemented

A store that sells only to Bangladesh behaves as before: the same tax
amounts, rounding, labels and rate snapshots for the same addresses, and the
same D1 calls and statements in every free-plan budget scenario.

**Regions** (D8, Stripe Tax's rule). A store collects tax only where it has a
tax region. A country region (`tax_regions`) is the registration. A
sub-region of it is an admin area (the address rules' code), a postal prefix
or, in Bangladesh, a City, Thana or Area place. An address in a country
without a region pays no tax, and no provider is asked. One rule
(`tax/region-match.ts`, browser safe) orders an address's regions most
specific first, as shipping zones do: Bangladesh place (area, thana, city),
postal prefixes (longest first), admin area, country. For a line's tax class,
the most specific region with rates of that class applies. A combinable rate
(Medusa's `is_combinable`) also applies the next broader region's rates of
the class, and so on, while every applied rate is combinable. Priority and
compound layers work as before. An order without an address (pickup,
service, digital) is taxed in the country of the default inventory location,
on that country's region only.

**Schema.** Migration `0116_tax_regions` (D1/Turso file, PostgreSQL sidecar,
ledger digest, schema contract 116, Drizzle snapshot):

- adds `tax_regions` (one region per scope). Triggers refuse a sub-region
  without its country region (`TAX_REGION_COUNTRY_REQUIRED`), a changed scope
  (`TAX_REGION_SCOPE_IMMUTABLE`) and a country deleted before its regions
  (`TAX_REGION_HAS_SUBREGIONS`);
- rebuilds `tax_rates` with `tax_region_id` and `combinable`, without the
  jurisdiction columns and soft deletion. Rates are deleted outright; orders
  keep their own copy;
- moves today's rates into Bangladesh regions: a store-wide rate to the region
  BD (`txreg_bd`), a place rate to its place's region, combinable. So the same
  rates stack for the same addresses as before;
- moves `prices_include_tax` from `tax_settings` to every market (each takes
  today's value) and adds `tax_settings.provider_id` (`system` by default);
- adds `country_code`, `tax_region_id` and `provider_id` to
  `order_item_tax_snapshots`, and `provider_id` and `provider_calculation_id`
  to `order_tax_snapshots`.

Region, rate and market-flag writes advance the checkout authority revision
and the `tax` cache dependency.

**Provider port.** The tax port is `calculate`, then `commit`, `void` or
`refund`, each idempotent. The built-in system provider (`system`,
`SYSTEM_TAX_PROVIDER`) implements it: `calculate` applies the merchant's rates
by region, and `commit`, `void` and `refund` are no-ops that return a stable
document id. An app's `defineTaxProvider` implements the same port. The rule
that selects the provider: the address's country region names one, else the
store-wide provider applies. `system` binds to the tax authority without a
read. An app id resolves through the request's `AppProviders`, so a store on
`system` reads no plugin table. Checkout fails closed: if the selected app is
not installed, not ready, fails or answers wrongly, the quote and the order are
refused (`tax_unavailable`). It never charges zero tax instead. The platform
rounds an app's tax half-up to the price increment and refuses an included
tax larger than the price. After an order commits, an app's calculation is
committed with the order id as its idempotency key. The port gained `refund`,
`shippingTaxCode`, `locationIds` and named tax lines (`name`, `rateRef`). All
changes are additive.

**Prices include tax** per market. Checkout, staff orders and the order's tax
snapshot read the order's market: the active market of the shipping country,
else the backup market. The checkout authority still reads tax in three
statements. The settings row carries each active market's flag and the origin
country, and the rate statement joins the regions. Order snapshot rows record
the new facts with the same bound parameters per line. The flag, the country
and the provider are SQL literals, so a 99-line order writes the same
statements. The order's destination and rate snapshots keep their shape.

**Dashboard.** Settings → Taxes follows Shopify's "Taxes and duties":

- Tax collection, with the store-wide tax service (only when an app offers
  one);
- Regions: each country, with its rates, regions and service. A country
  opens its page on the same screen (`?region=`), with its service, every
  rate and where it applies, its regions (Bangladesh places; other countries'
  states or postal codes) and "Stop collecting tax";
- tax groups and overrides, as before.

The sample order takes any country's address. Each market's page shows
"Prices include tax". Copy is in English and Bangla. Bundle budgets did not
change.

**Agents and MCP.** New registry rows: `dashboard.taxes.regions_list`,
`_get`, `_create`, `_update` (a country's provider) and `_delete`
(destructive). Rates take `taxRegionId` and `combinable`; tax settings take
`providerId`; markets take `pricesIncludeTax`. The tax workflow and the SDK
are regenerated.

**DVC.** `tax_regions` is registered with dependency `tax` (migration 0116).
`markets.prices_include_tax` is noise: only the live quote and the order show
it, and they read it under the checkout fence. No cached read shows tax. The
generator keeps the columns `0100` saw for `tax_rates` and `tax_settings`
(`CACHE_DEP_BASELINE_COLUMNS`). Migration 0116 reinstalls their generated
triggers. The property and race gate reports zero findings.

**Left for later.** Calling `void` on cancellation and `refund` on a refund
for app providers (the port and the snapshot's calculation id are ready).
Duties and import taxes. Tax registration numbers on invoices. Customer tax
exemptions. Tax overrides per collection.

## Store setup (G1a)

A fresh install no longer stays "Bangladesh". After the first admin, the
"Tell us about your store" step sets the backup market from the store's
country: its name and handle, its one country, the root language and the
currency's default price increment, with the shop currency, the store time
zone and the units, in one guarded batch. It runs only while the store has
no order and the backup market is as migration 0112 created it (revision 1,
the only market). It creates no tax region and no shipping zone. Details:
[STORE-DEFAULTS.md](STORE-DEFAULTS.md).

## Billing addresses (0119)

Shopify's rule. A store that sells only to Bangladesh shows no new field
for an order that ships, and its D1 calls and statements do not change.

**Rule** (`@scalius/shared/billing-address`, `billingAddressNeed()`):

- An order that ships is billed at its shipping address ("Billing address
  same as shipping", on by default).
- An order that ships nothing (only digital, service or gift-card lines)
  asks for a billing address. By default it is minimal: the country, plus
  the admin area and the postal code when the country's rules require them
  (what tax regions match on). The country select shows only when the
  active markets sell to more than one country; with one, that country is
  the billing country.
- A pickup order asks for none.
- Settings → Checkout → "Require full billing address" (off by default)
  asks every order for a full address by its country's rules. A shipped
  order then shows "Same as shipping address", ticked.
- A billing country must be one an active market sells to
  (`billing_country_unavailable`). A missing one is
  `billing_address_required`; a broken one `billing_address_invalid` with
  `details.issues`. When checkout does not ask, the API ignores what was
  sent.

**Tax** (`tax/region-match.ts`, `taxAddressSource()`): an order that ships
is taxed at its shipping address, a pickup order where it is collected (the
origin), and an order that ships nothing at its billing address (else the
origin). The order's market is the market of the taxed address's country.
The quote records `jurisdiction.addressSource`, and the order's tax
snapshot keeps it in `order_tax_snapshots.address_source` (an SQL
literal). The tax quote takes `billingCountryCode`, `billingAdminArea` and
`billingPostalCode`.

**Schema.** Migration `0119_billing_addresses` (D1/Turso file, PostgreSQL
sidecar, ledger digest, schema contract 119, Drizzle snapshot) adds to
`orders` the billing snapshot (`billing_name`, `billing_company`,
`billing_address`, `billing_address_line2`, `billing_country_code`,
`billing_dependent_locality`, `billing_locality`, `billing_admin_area`,
`billing_postal_code`, `billing_phone`, `billing_validation_skipped`) and
`billing_same_as_shipping`. A billing address has no City/Thana/Area
adapter. Nothing is backfilled: an older order has no billing address.
`customer_addresses.is_default_billing` marks one default billing address
per customer. Billing changes are `order.updated` and address-book changes
`customer.updated` (ids and states only). Orders and the address book are
private: no cache dependency.

**Cost.** The checkout order insert writes both billing flags as SQL
literals and leaves absent values out, so a shipped order binds no billing
value. The largest insert (a foreign delivery with a full separate billing
address) stays within 100 bound values.

**Surfaces.** Checkout (cart page, payment step, quick checkout; works
without JavaScript), the tax quote, agent checkout (a cart with nothing
physical is billed at the context's delivery country, region and postal
code), staff orders (create: "Same as delivery address" or an optional
billing address; edit: the order's details dialog; amendments keep it),
the order page, invoices ("Bill to", and "Ship to" when they differ), the
CSV export (billing columns at the end), the address book (dashboard,
account page and agents: `set_default_billing`) and the SDK.

**Left for later.** VAT and tax ID collection on billing addresses.
Payment provider address verification (AVS). Address autocomplete. The
billing address in order e-mails and on the buyer's receipt. Checkout
prefill from the default billing address.

## Step 4a implemented

A store with no price list and no adjusted market behaves as before: the
same bytes for every read, the same D1 calls and statements in every
free-plan budget scenario and render budget.

**Schema.** Migration `0120_price_lists` (D1/Turso file, PostgreSQL
sidecar, ledger digest, schema contract 120, Drizzle snapshot):

- `price_lists`: name, description, kind (`market` | `segment` | `sale`),
  market, segment (segment lists only), status (`draft` | `active`),
  `starts_at`/`ends_at`, priority (0 to 1,000) and a revision. A trigger
  keeps market and sale lists off the backup market
  (`PRICE_LIST_BACKUP_MARKET`), so the root catalogue never varies. Segment
  lists may price any market;
- `price_list_prices`: one row per list, SKU, currency and `min_quantity`,
  with `amount_minor` and an optional `compare_at_minor` above it;
- `markets` gains `price_mode` (`fixed` | `fx`), `fx_rate`,
  `price_adjustment_bps`, `price_rounding_minor` and `price_ending_minor`.
  Every market starts `fixed`; the backup market stays `fixed`.

Writes to an active list, its prices or a market's pricing advance the
checkout authority revision.

**The rule.** `resolvePrice()` in `@scalius/shared/market-pricing` is the
one precedence: a live sale list, then a segment list, then a market list,
then the FX-derived price, then the base price. Among lists of one kind the
higher priority wins, then the lower amount, then the smaller list id. A
list offers its row with the largest `min_quantity` that the quantity
reaches. A list price replaces the SKU price and its catalogue discount;
its compare-at (or, for a sale without one, the price without sales) is the
struck price. Promotions, bundles and app discounts apply after it.

**FX-derived prices.** `fxPriceMinor()`: base × rate × (1 + adjustment),
exact in integers. Without a rounding step, the result rounds half-up to the
price increment. With a step, it rounds up to the step, and an ending sets
the last part (step 10 and ending 9: 1,428.90 becomes 1,429). Prices are
computed at read time; nothing is stored. The rate is a cache dependency
(`pl:<market>`). The rate source is manual (`MANUAL_FX_RATE_SOURCE_ID`).
`FxRateSource` is the port for a rate provider app; no provider is wired
yet. While every market sells the shop currency, the rate is 1.

**Reads.** Products, categories, brands, collections, the homepage and
landing pages are market-keyed (`PUBLIC_API_CACHE_ROUTES`). A presence read
reads its market's price context in one more statement, beside its own
reads. A neutral market (no live public list, no adjustment) returns the
root's bytes. List prices ride in the SKU statements a read already runs.
Cards priced from the projection read the shown products' SKUs once more,
only while a list is live. Feeds, Product JSON-LD, search, quick add and
recommendations show the same prices. In an FX market, price filters are
inverted exactly.

**Checkout.** Cart validation, the tax quote, the order, agent carts and
staff orders price lines in the order's market: the shipping country when a
physical line ships, else the billed country, else the backup market. The
cart page uses the buyer's country, else the presence. Market pricing and
list prices ride in statements checkout already runs. Segment membership is
read only when a segment list applies to the cart.

**DVC.** New kind `pl`: `pl:<market>` (pricing columns, active public
lists) and `pl:<market>:<product>` (their prices). Drafts and segment lists
advance nothing. A list's next start or end bounds a cached entry
(`deps.validUntil`). The property and race gate reports zero findings; its
seed store has an FX market and four lists.

**Dashboard.** Products → Price lists (Medusa's price lists): the lists with
state, type, SKU count and schedule; create (market, segment or sale); an
editor with details, status, priority, schedule and a paged SKU price
table; a price grid sheet (loaded on first use) with compare-at prices and
up to four quantity breaks per SKU, at most 100 SKUs per save. Settings →
Markets → a market: a Pricing card (Shopify's price adjustment) with product
prices or adjusted prices, rounding step, ending and a live preview. Copy is
in English and Bangla. Bundle budgets did not change; the nav search words
moved out of the first download.

**Agents and MCP.** Registry rows `dashboard.price_lists.list`, `choices`,
`create`, `get`, `update`, `delete` (destructive), `prices_list` and
`prices_set`; markets take the pricing fields. RBAC: reads need
`products.view`, writes `products.edit`. The SDK is regenerated.

**Left for later.** Listing sort, price facets and discount sort use the
base or FX price in a market with lists. Sale lists on the backup market.
Segment lists in staff orders. Buyer-input surcharges and delivery charges
are not converted. A rate provider app through `FxRateSource`. A second
currency (step 6).

## Non-goals in this wave

Duties calculation, merchant-of-record, B2B company locations (later through
segments and price lists), multi-vendor sellers, per-channel stock counts.
