# Markets research: what Shopify, Medusa, Vendure, Saleor and WooCommerce learned the hard way

Researched 2026-10-03 for Scalius Commerce ("Markets": international selling, multi-currency, sales channels, translations, international tax and addresses). Sources are official docs, API references, engineering blogs and, for Medusa, Saleor and Vendure, the source code on GitHub `main`/`develop`. Community threads and issues are labelled as such. Where I could not verify something, I say so. Doc pages were read through a summarising fetcher, so exact strings quoted in the text were cross-checked only where I say "source".

---

## 1. Money representation

### 1.1 What each platform stores

| Platform | Stored as | Exponent source | Rounding | What an order carries |
|---|---|---|---|---|
| **Shopify** | API: `Decimal` serialised as string ([MoneyV2](https://shopify.dev/docs/api/admin-graphql/latest/objects/MoneyV2)). Internal Money gem: BigDecimal, README recommends `DECIMAL(21,3)` columns ([Shopify/money](https://github.com/Shopify/money)). Liquid/AJAX `cart.js`: integer minor units forced to 2 dp, so 1000 JPY is output as 100000 ([staff answer](https://community.shopify.dev/t/clarification-on-cart-js-money-values-minor-vs-major-units-and-decimal-places-per-currency/32824)) | Per currency (the gem handles JPY 0, MGA 1) | `allocate()`/`split()` never lose a minor unit | A [MoneyBag](https://shopify.dev/docs/api/admin-graphql/latest/objects/MoneyBag) (`shopMoney` + `presentmentMoney`) on every price field; `Order.currencyCode` = shop currency at order time, `presentmentCurrencyCode` = what the buyer used ([Order](https://shopify.dev/docs/api/admin-graphql/latest/objects/Order)) |
| **Medusa v2** | `bigNumber` column plus a `raw_` JSON twin, bignumber.js, `DEFAULT_PRECISION = 20` significant digits ([source](https://github.com/medusajs/medusa/blob/develop/packages/core/utils/src/totals/big-number.ts)). **Major units**: "$20.00 is stored as `20`" ([docs](https://docs.medusajs.com/resources/commerce-modules/pricing/concepts)); v1 stored cents ([v1→v2](https://docs.medusajs.com/learn/introduction/from-v1-to-v2)) | Currency module has `decimal_digits` and `rounding` ([model](https://github.com/medusajs/medusa/blob/develop/packages/modules/currency/src/models/currency.ts)), but the Stripe provider hard-codes its own zero/three-decimal lists ([source](https://github.com/medusajs/medusa/blob/develop/packages/modules/providers/payment-stripe/src/utils/get-smallest-unit.ts)) | Totals are never rounded; rounding happens only when converting to a provider's smallest unit | One `currency_code`, `region_id`, `sales_channel_id` ([Order model](https://github.com/medusajs/medusa/blob/develop/packages/modules/order/src/models/order.ts)); no shop-currency twin in the model I read |
| **Vendure** | Integer minor units via `MoneyStrategy`; default column is `int` (about 21.4M cap), `BigIntMoneyStrategy` for more ([MoneyStrategy](https://docs.vendure.io/reference/typescript-api/money/money-strategy)) | One global `precision`; docs call it "merely a hint to the UI", and tell frontends to divide by 100 ([guide](https://docs.vendure.io/guides/core-concepts/money/)). No per-currency table in the docs | `Math.round(value * quantity)` by default | Single currency from the channel |
| **Saleor** | `DECIMAL(20,3)` for every currency (`DEFAULT_DECIMAL_PLACES = 3`, [settings](https://github.com/saleor/saleor/blob/main/saleor/settings.py)); `Money(amount, currency)`, precision "determined by the currency" ([prices](https://docs.saleor.io/api-usage/prices)); `TaxedMoney` = gross + net | From the currency | Half-up ([taxes](https://docs.saleor.io/developer/taxes)) | Channel currency |
| **WooCommerce** | `wc_orders.total_amount decimal(26,8)` and one `currency` column "in which payment was received" ([HPOS schema](https://developer.woocommerce.com/2022/09/15/high-performance-order-storage-database-schema/)) | Core is single-currency; plugins bolt on | Plugin-specific | Exchange rate lives in plugin order meta (Aelia reports use the rate stored on each order, [docs](https://docs.zorem.com/docs/sales-report-by-country-for-woocommerce/compatibility/)) |

Reading: integer minor units (Vendure, Stripe's wire format, us) and exact decimals (Shopify, Saleor, Medusa) both work. Failures came from three other things: a global precision (Vendure), a fixed 2 dp public contract (Shopify AJAX), and unrounded intermediate values (Medusa).

### 1.2 Exponent edge cases: three different tables

There are three separate facts per currency, and platforms that merge them get bitten.

1. **Storage exponent** (ISO 4217): JPY 0; BHD, KWD, JOD, OMR, TND 3; CLF 4; BDT 2 ([Adyen table](https://docs.adyen.com/development-resources/currency-codes) lists BDT at 2 and the seven three-decimal currencies).
2. **Display and cash rules** (CLDR [`supplementalData.xml`](https://github.com/unicode-org/cldr/blob/main/common/supplemental/supplementalData.xml)): CLF `digits=4`; BHD, KWD, JOD, OMR, TND `digits=3`; CHF `cashRounding=5` (0.05); CAD `cashRounding=5`; DKK `cashRounding=50`; SEK, NOK, PKR, TWD `cashDigits=0`. CLDR also lists IDR, COP and ISK at 0 digits. BDT has no entry, so the default of 2 applies. Whole-taka rounding is therefore a Scalius/merchant rule, not CLDR.
3. **PSP wire exponent**, which disagrees with both:
   - Stripe: ISK and UGX are "two-decimal where the decimal amount is always `00`"; HUF and TWD are charged at 2 dp but paid out as zero-decimal ([Stripe currencies](https://docs.stripe.com/currencies)). Stripe's max-charge table treats IDR as two-decimal (9,999,999,999.99).
   - Adyen: "For CLP, CVE, IDR, and ISK the ISO 4217 standard has a different number of decimals"; Adyen lists IDR as zero-decimal. So Stripe and Adyen disagree on IDR.
   - Checkout.com: three-decimal currencies need the last digit `0`; CLP needs the last two digits `00` ([doc](https://www.checkout.com/docs/payments/accept-payments/calculating-the-amount)).
   - Medusa's Stripe adapter encodes this as hard-coded arrays, `Math.round` on JS doubles, and `Math.ceil(n/10)*10` for three-decimal currencies. That means the charged amount can exceed the stored order total by up to 0.009 KWD.

**Takeaway:** keep a per-currency table (`exponent`, `cashIncrement`, display digits) and a per-gateway amount codec that can refuse or round with a recorded difference. Never a global precision.

### 1.3 Where conversion and rounding happen; what is stored per order

- **Shopify** converts at price-resolution time (market currency settings plus catalog adjustments, then optional rounding), snapshots both `shopMoney` and `presentmentMoney` on every order money field, and keeps payment-side data on [`OrderTransaction`](https://shopify.dev/docs/api/admin-graphql/latest/objects/OrderTransaction): `amountSet`, `settlementCurrency`, `settlementCurrencyRate`, and `currencyExchangeAdjustment` ("amount lost or gained due to fluctuations"). That is three layers: presentment, shop, settlement.
- **Stripe** names the same three: customer's method currency, *presentment* (the charge), and *settlement* (your bank) ([doc](https://docs.stripe.com/currencies)).
- **Shopify's fee is baked into prices.** The Payments conversion fee is 1.5% in the US and 2% elsewhere on top of a mid-market rate ([fees](https://help.shopify.com/en/manual/international/pricing/fees)). A developer saw a 1000 SEK draft-order discount applied as 1020.05 SEK in a foreign presentment currency ([thread](https://community.shopify.dev/t/applieddiscount-discrepancy-between-value-and-amountset-shopamount/9843)). Treat that as community evidence, not a Shopify statement.
- **Medusa** keeps one currency and unrounded BigNumbers. Issues report $24.99 at 10.75% tax producing 2.686425 stored vs 2.69 charged ([#14818](https://github.com/medusajs/medusa/issues/14818)), and 0.5 × $1.99 at 7% rounding to $1.06 vs $1.07 because rounding happens only in `getSmallestUnit` ([#13734](https://github.com/medusajs/medusa/issues/13734)). Both are closed "not planned", so this is a live property of the design.

### 1.4 Refunds in a converted currency

- Stripe: the customer is refunded "the exact amount they paid and in the currency they paid in"; the merchant's balance is debited at the *current* rate. Example: a 60 USD payment settled at 0.88 gives 52.80 EUR, and a refund at 0.86 debits 51.60 EUR ([localize prices](https://docs.stripe.com/payments/currencies/localize-prices)).
- Shopify: conversion happens "when you capture a payment, you issue a refund, or when there is a chargeback"; it recommends refunding the full local-currency amount ([exchange rates](https://help.shopify.com/en/manual/markets/pricing/exchange-rates)). Refund creation on multi-currency orders requires an explicit `currency` ([partner blog](https://www.shopify.com/partners/blog/multi-currency-app-developers)).
- WooPayments is the same: refund at refund-time rate, customer gets the original amount ([docs](https://woocommerce.com/document/woopayments/currencies/multi-currency-setup/)). The plugin-era failures reported in support forums (surfaced by search, not individually verified) were refunds issued in base currency, which PSPs reject, and analytics mislabelling a JPY refund as GBP.

**Rule everyone converges on:** the buyer-facing refund is always in presentment currency; the FX delta is merchant P&L, recorded separately.

### 1.5 FX rate source, locking, staleness

- **Stripe** applies mid-market from third-party data and exposes an [FX Quotes API](https://docs.stripe.com/payments/currencies/localize-prices/fx-quotes-api): lock for 5 minutes, 1 hour or 24 hours (a `duration_premium` of 0.07% to 0.30% depending on currency group), with `reference_rate_provider: ecb`. A payment quote is invalidated if the rate moves more than 3.5% (`fx_quote.expired` webhook). Adaptive Pricing adds a 2% to 4% conversion fee to the shown price.
- **Shopify** does not document its source or cadence ([exchange rates](https://help.shopify.com/en/manual/markets/pricing/exchange-rates)). Merchants can set a **manual rate per market** to stop prices drifting.
- **WooPayments**: rates from their servers, "not accurate to the minute", manual override allowed.
- **Medusa, Saleor and Vendure** have no FX at all; the Vendure hook is [`ProductVariantPriceUpdateStrategy`](https://docs.vendure.io/reference/typescript-api/configuration/product-variant-price-update-strategy), whose default updates nothing.

---

## 2. Pricing

- **Fixed per-currency prices only:** Medusa ("complete control over the format and value of the price… per currency and region", [v1 recipe](https://docs.medusajs.com/v1/recipes/multi-region)), Saleor (`ProductVariantChannelListing`, one per channel), Vendure (`ProductVariantPrice` keyed by channel and currency, [pricing](https://docs.vendure.io/current/core/core-concepts/pricing)).
- **FX-derived plus overrides:** Shopify. A catalog's `PriceListParent` applies a percentage adjustment to the converted base; a fixed price on a product overrides it; "the price is determined by the lowest price" across multiple catalogs on one buyer ([catalogs](https://shopify.dev/docs/apps/build/markets/catalogs), [adjustments](https://help.shopify.com/en/manual/markets/pricing/price-adjustments)).
- Stripe's own guide frames the trade-off as three modes: automatic (Adaptive Pricing), quote-locked (FX Quotes), and manual static prices that carry "greater exchange risk" ([doc](https://docs.stripe.com/payments/currencies/localize-prices)).

**Price lists / catalogs.** Shopify's catalog = publication (what) + price list (how much) + context (market, company location, app) with priority company location > market > app. Medusa: price set per variant; each price has `currency_code`, `min_quantity`/`max_quantity`, and rules (`region_id`, `customer.groups.id`, `shipping_address.postal_code`, `item_total`). The most-specific match wins by rule count ([calculation](https://docs.medusajs.com/resources/commerce-modules/pricing/price-calculation), [rules](https://docs.medusajs.com/resources/commerce-modules/pricing/price-rules)). Price lists are `sale` or `override` and date-bound. Saleor says channels do not work for supplier-specific pricing (a checkout is scoped to one channel) and points to price-list functionality; customer-specific pricing via channels is possible but heavy ([channels](https://docs.saleor.io/developer/channels/overview)). Vendure has no price lists in core; extend `OrderItemPriceCalculationStrategy`.

**Compare-at and sale.** Shopify's percentage adjustment applies to compare-at by default, with a toggle to set it manually. Medusa returns `calculated_price` and `original_price` (the original is null when only a sale list matches). Saleor added `pricePrior` (3.21) and deliberately does not track it, because "there are many different interpretations of the lowest price" (EU Omnibus: lowest price in the prior 30 days) ([doc](https://docs.saleor.io/developer/discounts/displaying-catalogue-discounts)). Compare-at is a legal, per-market concept, not just a strikethrough.

**Tax-inclusive per market.**
- Shopify: `MarketPriceInclusions` has `inclusiveTaxPricingStrategy` (`ADD_TAXES_AT_CHECKOUT`, `INCLUDES_TAXES_IN_PRICE`, `INCLUDES_TAXES_IN_PRICE_BASED_ON_COUNTRY`) and a separate duties strategy ([object](https://shopify.dev/docs/api/admin-graphql/latest/objects/MarketPriceInclusions), [enum](https://shopify.dev/docs/api/admin-graphql/latest/enums/InclusiveTaxPricingStrategy)).
- Medusa: `PricePreference(attribute = region_id | currency_code, is_tax_inclusive)`, region beating currency ([doc](https://docs.medusajs.com/resources/commerce-modules/pricing/tax-inclusive-pricing)). In v1 this was `includes_tax` on Region, Currency, PriceList and ShippingOption ([v1 doc](https://docs.medusajs.com/v1/modules/taxes/inclusive-pricing)).
- Vendure: `Channel.pricesIncludeTax`, one flag per channel; the default price sync notes that different tax settings across channels are not reconciled.
- Saleor: `TaxConfiguration` per channel with `prices_entered_with_tax` (data) separate from `display_prices_with_tax` (presentation).

**Rounding endings.** Shopify rounds converted prices and shipping rates to one non-customisable default per currency, Payments only ([rounding](https://help.shopify.com/en/manual/markets/pricing/rounding)); merchants asked for 0.95 and finer steps ([thread](https://community.shopify.com/t/rounding-prices-in-markets-to-0-95-no-longer-available/271931)). WooPayments offers rounding to 0.25/0.50/1.00 and "charm pricing" (minus 0.01 or 0.05) and warns it also affects taxes and shipping.

**Quantity breaks.** Shopify: `quantityPriceBreaks` and `quantityRule` inside contextual pricing ([doc](https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariantContextualPricing)). Medusa: `min_quantity`/`max_quantity` on a price. The others: custom.

---

## 3. Market / Region / Channel model

| | Shopify **Market** | Medusa **Region** | Vendure **Channel** | Saleor **Channel** |
|---|---|---|---|---|
| Is | A set of *conditions* (region, company location, retail location) a buyer matches ([Market](https://shopify.dev/docs/api/admin-graphql/latest/objects/Market)) | A country group with one currency | A full tenant slice: token, languages, currencies, tax and shipping zones, seller | One currency, one `default_country`, warehouses, shipping zones, tax config |
| Carries | `currencySettings`, `priceInclusions`, `webPresences`, `catalogs`, `delivery`, `discounts`, `returnPolicyProfile`, parent/child hierarchy | `name`, `currency_code`, `automatic_taxes`, countries, payment providers ([region.ts](https://github.com/medusajs/medusa/blob/develop/packages/modules/region/src/models/region.ts)) | `defaultLanguageCode`/`availableLanguageCodes`, `defaultCurrencyCode`/`availableCurrencyCodes`, `pricesIncludeTax`, `defaultTaxZone`, `defaultShippingZone`, `seller` ([entity](https://docs.vendure.io/reference/typescript-api/entities/channel)) | Order, checkout, payment and tax settings ([model](https://github.com/saleor/saleor/blob/main/saleor/channel/models.py)) |
| Countries | Many per market; `null` currency settings inherit from the parent market ([changelog](https://shopify.dev/changelog/new-markets-apis)) | A country belongs to at most one region (`iso_2` is the Country primary key, `region` nullable, [country.ts](https://github.com/medusajs/medusa/blob/develop/packages/modules/region/src/models/country.ts)) | Zones hold countries; channels point at zones | Via shipping zones |
| Languages | Per market; shared across markets that use the language | Not on region (Translation module separate) | Per channel | Per query (`languageCode` argument) |

**How a request picks a market.**
- Shopify infers. "Shopify ranks the markets a buyer matches from most specific to least specific and applies the most specific match" ([markets overview](https://shopify.dev/docs/apps/build/markets)), and market IDs and handles are not stable identifiers. Headless callers pass `@inContext(country, language)`; once a cart has `buyerIdentity` it wins over `@inContext` and "context within the cart is progressive" as the address arrives ([in-context](https://shopify.dev/docs/storefronts/headless/building-with-the-storefront-api/in-context), [pricing](https://shopify.dev/docs/custom-storefronts/building-with-the-storefront-api/internationalization/international-pricing)). Auto-redirect by browser location is offered, but EU stores must use consent-based alternatives ([domains](https://help.shopify.com/en/manual/markets/international-domains)); crawlers are never geo-redirected ([SEO](https://help.shopify.com/en/manual/markets/seo)).
- The others make the client say which one: Medusa `region_id` on the cart plus `x-publishable-api-key` for the sales channel; Vendure `vendure-token` header; Saleor the channel slug per query.

**Default market.** Shopify deprecated the "primary market" (API 2025-04) in favour of `backupRegionUpdate`: "a shop-wide region to use when no better option can be determined from buyer signals". Vendure always has a default channel containing every entity. Medusa's Store marks one `is_default` currency.

**Catalog scope.** All of them keep one product catalog and scope it by publication, channel link or channel listing. Vendure's channel-aware list is 13 entities (Asset, Collection, Customer, Facet, FacetValue, Order, PaymentMethod, Product, ProductVariant, Promotion, Role, ShippingMethod, StockLocation, [guide](https://docs.vendure.io/guides/core-concepts/channels/)); creating a product in a sub-channel also puts it in the default channel.

**URLs.** Shopify recommends subfolders (`/en-ca`) for shared authority; subdomains and ccTLDs are options, with auto hreflang (including `x-default`), self-canonicals and per-market sitemaps ([SEO](https://help.shopify.com/en/manual/markets/seo)). Web presences were decoupled from markets in 2025-04 (many-to-many).

---

## 4. Sales channels

- **Shopify:** a `Publication` is "a group of products and collections that are published to an app", with scheduled publishing, and is optional when a catalog is used ([Publication](https://shopify.dev/docs/api/admin-graphql/latest/objects/Publication)). Order attribution is `Order.channelInformation` = `app` + `channelDefinition` (for example Instagram Shopping) + `channelId` ([ChannelInformation](https://shopify.dev/docs/api/admin-graphql/latest/objects/ChannelInformation)). POS enters the *market* model as a retail-location condition ([developer preview](https://shopify.dev/docs/apps/build/markets/new-markets/developer-preview)).
- **Medusa:** the Sales Channel module links products ("which products are available per channel"), scopes carts and orders, and links to stock locations so available inventory is resolved per channel ([doc](https://docs.medusajs.com/resources/commerce-modules/sales-channel)).
- **Vendure:** `StockLocation` is channel-aware; `StockLocationStrategy` picks locations for allocation ([stock control](https://docs.vendure.io/guides/core-concepts/stock-control/)).
- **Saleor:** "a warehouse must be assigned to a channel", and one warehouse can serve many. Filtering by shipping zone and destination is the *deprecated* legacy mode ([stock](https://docs.saleor.io/developer/stock/overview)). Checkout belongs to exactly one channel.

**Naming trap for us:** in Medusa, Saleor and Vendure "channel" means a selling context with its own catalog, currency and stock. Our `order.channel` (`online_store | admin | pos | agent | app` plus `channelSource`) is closer to Shopify's `channelInformation`: an attribution surface. Keep it that way, and call the new pricing/tax/language bundle a **market**.

---

## 5. Addresses

**The reference data.** Google's libaddressinput metadata ([wiki](https://github.com/google/libaddressinput/wiki/AddressValidationMetadata)) gives per country: `fmt` (field order via `%N %O %A %C %S %Z %D`), `require`, `upper`, `zip` regex and `zipex`, `sub_keys`, and label types (`state_name_type`, `zip_name_type`, `locality_name_type`). Examples I pulled from [the live data](https://chromium-i18n.appspot.com/ssl-address/data/BD):

| Country | Shape |
|---|---|
| BD | `fmt %N%n%O%n%A%n%C - %Z`, `zip \d{4}`, no `require`, no subdivision list |
| US | `require ACSZ`, state list, ZIP+4 |
| JP | postal code first, prefecture required, separate Latin format (`lfmt`) |
| GB | `post_town`, large postcode regex |
| AE | no postal code, emirate required |
| HK | no postal code, area/district |
| IE | Eircode plus `%D` dependent locality |
| BR | neighbourhood, `ASCZ` |

**What platforms store.**
- Shopify: a small fixed record: `address1/2`, `city`, `province` + `provinceCode`, `zip`, `country` + `countryCodeV2`, `phone`, `company`, names ([MailingAddress](https://shopify.dev/docs/api/admin-graphql/latest/objects/MailingAddress)). Country-specific extra fields (Brazil, Japan and others) are *merged back* into `address1/address2` with a word-joiner via Worldwide ([doc](https://shopify.dev/docs/apps/build/checkout/delivery-shipping/additional-address-fields)). Its open-source [Worldwide](https://github.com/Shopify/worldwide) builds on CLDR, libaddressinput and ISO, and the [engineering post](https://shopify.engineering/handling-addresses-from-all-around-the-world) describes the problems: field order (Japan starts with postal code), naming ("zone" means department in Peru) and localisation (〒, honorifics).
- Medusa: `address_1/2`, `city`, `country_code`, `province`, `postal_code`, `phone`, all nullable ([model](https://github.com/medusajs/medusa/blob/develop/packages/modules/customer/src/models/address.ts)). Vendure: `streetLine1` required, rest default `''`, and `country` is a relation into zones ([Address](https://docs.vendure.io/reference/typescript-api/entities/address)).
- Saleor: `street_address_1/2`, `city`, `city_area`, `postal_code`, `country`, `country_area`, a validated `phone`, and a `validation_skipped` flag ([model](https://github.com/saleor/saleor/blob/main/saleor/account/models.py)). Rules are served from libaddressinput by `addressValidationRules(countryCode)`, returning `allowedFields`, `requiredFields`, `postalCodeMatchers` and `postalCodeExamples` so forms render per country ([doc](https://docs.saleor.io/developer/address)).

**Convergence:** flat structured columns, country-driven *rules* kept outside the schema, and an escape hatch for unvalidated addresses. Nobody models "city/zone/area IDs" as the canonical address; those are carrier or country-specific layers.

**Phone:** Saleor validates phone numbers as possible numbers; Shopify's Worldwide also validates phones. Store E.164 plus the raw input.

---

## 6. Tax

- **Inclusive vs exclusive and regions:** see §2. Jurisdiction models: Medusa `TaxRegion(country_code, province_code, parent, provider)` with DB checks (a child needs a province; a child may not have a provider), plus `TaxRate` and rate rules ([model](https://github.com/medusajs/medusa/blob/develop/packages/modules/tax/src/models/tax-region.ts)). Vendure `TaxCategory` × `Zone` → `TaxRate`, and channel `defaultTaxZone`; `TaxZoneStrategy` can switch to address-based ([taxes](https://docs.vendure.io/guides/core-concepts/taxes/)). Saleor flat country rates with tax classes, or a tax app.
- **Provider abstractions:**
  - Medusa: `ITaxProvider`, a built-in `tp_system`, and a provider chosen per top-level tax region ([doc](https://docs.medusajs.com/resources/commerce-modules/tax/tax-provider)). v2 dropped the "override the strategy" hook for "custom tax provider in a tax region".
  - Saleor: `TAX_CALCULATE_*` synchronous webhooks, strategy `FLAT_RATES` vs `TAX_APP`, and an AvaTax app that voids the Avalara transaction on `OrderCancelled` ([app](https://docs.saleor.io/developer/app-store/apps/avatax/overview)).
  - Vendure: `TaxLineCalculationStrategy`, with the warning to cache because it runs on every order change ([ref](https://docs.vendure.io/reference/typescript-api/tax/tax-line-calculation-strategy)).
  - Stripe Tax standalone: `calculation` then `transaction`, per-line `tax_behavior`, ship-from address, `taxability_override`/reverse charge with tax IDs, a per-jurisdiction breakdown (state, county, city, district), **zero tax where you have no registration**, and IP geolocation for estimates only ([doc](https://docs.stripe.com/tax/custom)).
- **Duties and DDP/DDU:** Shopify can "collect an estimate of those amounts at checkout", which needs HS codes and de-minimis configuration ([help](https://help.shopify.com/en/manual/international/duties-and-import-taxes)). Its `adaptivePricingEnabled` flag is "only applicable to Managed Markets" (merchant-of-record). The rules move: the US suspended duty-free de minimis for all countries from 2025-08-29 ([White & Case](https://www.whitecase.com/insight-alert/united-states-suspend-customs-de-minimis-entry-most-shipments-august-29-2025)); the EU removed its €150 customs relief from 2026-07-01 for a temporary €3 flat duty per item category ([Ibec](https://www.ibec.ie/sfa/news-insights-and-events/insights/2026/03/09/reminder---150-eur-customs-duty-exemption-threshold-to-be-removed-as-of-1-july-2026)). Duties must be provider/data-driven, not coded.
- **Rounding:** Medusa's unrounded tax lines are its biggest reported flaw (§1.3). Vendure rounds `price × quantity` once. Per-line vs per-invoice tax rounding is jurisdiction-specific (my inference; no source consulted), so keep the algorithm explicit and store the tax lines as computed.

---

## 7. Translations

| | Storage | Fallback | Scope |
|---|---|---|---|
| **Shopify** | Key/value per resource and locale, tied to a content **digest** so edits to the source flag stale translations; optional `marketId` for market-specific text ([TranslationInput](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/TranslationInput)) | Automatic to primary-language content | 28+ `TranslatableResourceType`s: products, options and values, collections, pages, menus, filters, theme files, email and packing-slip templates, delivery methods, payment gateways, shop policies, selling plans, metaobjects. Tags are not translatable ([enum](https://shopify.dev/docs/api/admin-graphql/latest/enums/TranslatableResourceType), [guide](https://shopify.dev/docs/apps/build/markets/manage-translated-content)) |
| **Medusa** | One `Translation` row per `(reference, reference_id, locale_code)` with a JSON `translations` map; BCP 47 locales ([concepts](https://docs.medusajs.com/resources/commerce-modules/translation/concepts)) | "Doesn't enforce a default locale"; returns the original value | Products, variants, categories, collections, options, tags, types, customer groups, regions, shipping options, tax rate names. Needs v2.12.3+ and a feature flag ([module](https://docs.medusajs.com/resources/commerce-modules/translation)) |
| **Vendure** | `Translatable` entity + one `*Translation` row per language (`LocaleString` fields) ([guide](https://docs.vendure.io/guides/developer-guide/translatable/)) | Chain: request language → channel default → server default → `en` → first row; newer code also falls back per empty field ([source](https://github.com/vendure-ecommerce/vendure/blob/master/packages/core/src/service/helpers/translator/translator.service.ts)) | Product, variant, collection, facet, and so on |
| **Saleor** | Per-model translation tables with `language_code` | Untranslated fields return `null`; the client implements fallback ([i18n](https://docs.saleor.io/api-usage/i18n)) | Products, categories, collections, attributes, pages, and so on |

**SEO.** Google needs reciprocal, self-referencing `hreflang` (language-region, plus `x-default`) via HTML, header or sitemap ([doc](https://developers.google.com/search/docs/specialty/international/localized-versions)). It warns that locale-adaptive pages (one URL, content by IP or `Accept-Language`) may not be fully crawled and recommends separate locale URLs ([doc](https://developers.google.com/search/docs/specialty/international/locale-adaptive-pages)). Shopify implements exactly this: subfolders by default, generated hreflang/canonicals/sitemaps, and crawlers excluded from geo-redirects.

---

## 8. Lessons: what each platform got wrong first

**Shopify**
1. Single currency → Payments-only multi-currency → Markets. The app-developer fallout: "you can no longer assume that the currency you currently retrieve from the Shopify API is in either shop currency or presentment currency"; refunds and captures must pass `currency`; `TenderTransaction` was introduced for reporting ([blog](https://www.shopify.com/partners/blog/multi-currency-app-developers)).
2. Local-currency charging is gated on the payment provider: only Shopify Payments and Adyen charge in local currency. With any other gateway, including manual methods such as COD, local currency is *display-only* and the buyer is charged in the shop currency ([payments](https://help.shopify.com/en/manual/markets/payments)). This is the closest precedent to our COD case.
3. The Markets API itself was re-modelled in 2025-04: "primary market" → backup region; markets = conditions (region, B2B company location, retail location) with inheritance; web presences and catalogs became many-to-many; province-level scope from 2025-10.
4. Fixed-width public contract: AJAX values forced to 2 dp, so 1000 JPY becomes 100000 and clients "must use external ISO 4217 libraries".
5. Non-customisable rounding drew merchant complaints.

**Medusa**
1. v1 → v2: cents → major-unit BigNumber; `MoneyAmount`/`region_id` and `includes_tax` flags on four entities → price sets, rules and `PricePreference`; tax strategy override → tax providers. Region = exactly one currency; country in one region. Translation arrived only in 2.12.3 behind a flag.
2. Rounding: unrounded BigNumbers push the problem to the PSP boundary (#14818, #13734, both closed "not planned").
3. PSP exponent knowledge hard-coded inside one provider, not in the Currency module.

**Vendure**
1. v1 needed a channel per currency; v2.0 added per-currency prices inside a channel so you "no longer need to create new Channels (with all the overhead that implies)" ([2.0 beta](https://vendure.io/blog/announcing-vendure-2-0-beta)).
2. Channels-as-vendors were "somewhat workable" but "much more complex than it should be", so v2 added a `Seller` entity, one channel per seller, aggregate plus seller orders, and a Stripe-Connect-style fee split ([guide](https://docs.vendure.io/guides/how-to/multi-vendor-marketplaces/)).
3. The internal order model was reworked: 360× faster on a 5,000-item order.
4. The default 32-bit `int` money column caps at about 21.4M minor units, which led to `BigIntMoneyStrategy`.

**Saleor**
- Channel = one currency, and a checkout cannot move channels, so channels are "not ideal for dynamic currency conversion". The legacy warehouse-by-shipping-zone stock filter is deprecated in favour of warehouse-channel assignment. `pricePrior` is manual by design.

**WooCommerce**
- Single-currency core plus plugins means: no shop/presentment pair on the order, analytics that mislabel refunds (forum reports), and an `OrderMetaHelper` in WooPayments' own code intended to repair wrong exchange rates on orders (seen in a search result, not verified against the repo).

---

## 9. Converged best practice, and how to apply it from BDT/COD

### Copy these decisions

1. **Money = `{amountMinor: integer, currency}` everywhere.** Keep integers (they suit D1/SQLite and match PSP wire formats). Add a per-currency policy table: `exponent`, `cashIncrementMinor` (BDT 100 for cash, CHF 5, DKK 50, CAD 5), and `displayDigits`. Add a **per-gateway amount codec** (Stripe ISK/UGX `00`, three-decimal last digit `0`, Adyen's IDR) that records any rounding difference rather than silently ceiling it. Do not use one global precision.
2. **Orders snapshot the whole money chain.** Presentment amounts are the buyer truth. Add a shop-currency snapshot with `fxRate` (decimal string), `fxSource`, `fxAsOf` and `fxLockedUntil`, fixed when checkout starts. Put **settlement amounts and rates on the payment transaction**, as Shopify's `OrderTransaction` does. Refunds are in presentment currency; the FX difference goes on its own ledger line (Shopify's `currencyExchangeAdjustment`).
3. **Pricing:** fixed per-market prices are first-class (Medusa/Saleor/Vendure). FX-derived prices are an optional *generator* of those rows (Shopify, Stripe), with an explicit rounding policy (increment or ending such as .95) and manual-rate override per market. Use deterministic precedence: rule specificity (Medusa) or lowest-wins (Shopify), but document one. Compare-at lives on the same row, with an optional prior-price field for Omnibus-style rules.
4. **A Market is a configuration bundle selected by conditions** (Shopify), not "one country, one currency" (Medusa) and not a whole tenant (Vendure/Saleor channel). Bundle: countries, currency, languages, URL presence, price lists, tax inclusivity, shipping, payment methods, availability. Add a shop-wide *backup* market. Resolve on the server: explicit buyer choice > cart address country > URL > geo hint > backup. One URL per locale/market; never locale-adaptive content on one URL.
5. **Separate three ideas:** `market` (pricing/tax/language context), `sales channel` (publication and optional stock-location link), and `order.channel` (attribution; keep as is). Never keep per-channel stock counts.
6. **Payment methods declare `chargeCurrencies`.** COD charges BDT only; if a buyer sees USD, that is a display price and the checkout must say what is charged (Shopify's display-only trap).
7. **Tax:** `pricesIncludeTax` per market; persisted tax lines per order line with jurisdiction, rate, taxable base, inclusive flag and provider id; a provider interface (`calculate` → `commit` → `void/refund`, idempotent) like Medusa/Saleor/Stripe, with `flat/manual` as one provider and BD city/zone/area as a jurisdiction type of it. Duties/DDP-DDU are separate lines, data-driven. Keep your largest-remainder allocation; Medusa's missing rounding is the counter-example.
8. **Addresses:** canonical structured columns (country, admin area, locality, dependent locality, postal code, street 1/2, name, company, E.164 phone) validated by country metadata from libaddressinput/CLDR (Saleor's `addressValidationRules` shape). Keep BD `city/zone/area` IDs as a *Bangladesh adapter* alongside text labels, because couriers need those IDs.
9. **Translations:** one generic table keyed by `(resourceType, resourceId, field, locale, marketId?)` with a source-content digest (Shopify) so stale translations are visible; fallback chain market locale → store default → source value (Vendure's chain); localised slugs unique per locale; hreflang generated from the published locale×market matrix; templates (emails, invoices) translatable.
10. **Multi-vendor is a Seller entity, not a channel.**

### Traps for a BDT/COD-first platform

- **BDT is baked in at several layers.** `cashRoundingMinor("BDT") = 100` and `requiresWholeCashAmounts` must become currency × payment-method policy, not a currency special-case. `assertDecimalPlaces` currently rejects exponent 4 (CLF and UYW): decide to exclude them explicitly rather than by accident. Schema `DEFAULT 'BDT'` on `currency`/`currency_code` columns is fine for legacy rows; new tables should require a currency.
- **Order addresses are BD-shaped** (`city`, `zone`, `area` IDs and names). Add `country_code` and generic locality columns before the first foreign order; migrating after volume is the painful path.
- **Do not let the PSP decide presentment currency** (Shopify) or let the PSP's exponent leak into storage (Medusa).
- **Do not adopt a global precision** (Vendure) or fixed 2 dp in public contracts (Shopify AJAX). Our HTTP contract of decimal major units converted at the edge is right, provided the edge uses the *order's* `currencyDecimalPlaces` and never a constant.
- **Do not overload "channel"** (see §4); retrofitting a rename after a public API ships is costly.
- **Do not hide rounding policy** (Shopify) or leave it unbounded (Medusa).
- **Cache dimensions:** with DVC, every public read must include market, currency, locale and price-list identity in its key and dependencies, or you will serve BDT prices to a USD buyer. Product feeds, sitemaps and robots become per-market (per domain or subfolder) and must keep failing closed on non-absolute URLs.
- **Rates need an owner.** Choose one source, a staleness TTL and a lock-at-checkout rule up front; Shopify never documented theirs, and merchants hit the gap.

### Sequence that avoids a rewrite

1. Add currency policy, per-gateway codec, order FX snapshot fields and payment-transaction settlement fields (all no-ops while only BDT).
2. Introduce `market` with exactly one default market that mirrors today's store (BDT, bn/en, BD).
3. Generalise addresses and tax jurisdictions behind adapters.
4. Add price lists and translations keyed by market and locale.
5. Only then turn on a second currency, with fixed prices first and FX generation later.
