# Price lists

Market pricing (docs/MARKETS-DESIGN.md D5, "Step 4a implemented"): price lists and their prices, FX-derived prices, and the code that prices a SKU in a market for every surface. Read this before you change how a buyer's price is found.

## Entries and layer

`index.ts` is the only entry. Layer L4: the domain imports `customers` (segment membership), `markets`, `products` (the base buyer price) and `settings`. `catalog`, `checkout`, `orders` and `storefront` import it.

## The rule

`resolvePrice()` in `@scalius/shared/market-pricing` is the one precedence: an active sale list, then a segment list, then a market list, then the FX-derived price, then the base price. Among lists of one kind the higher priority wins, then the lower amount, then the smaller list id. A list offers the row with the largest `min_quantity` the quantity reaches. A list price replaces the SKU price and its catalogue discount. Promotions, bundles and app discounts apply after it.

## Files

| File | Purpose |
|------|---------|
| `price-lists.service.ts` | The dashboard aggregate: list, create, update, delete, the SKU price grid (`listPriceListVariants`, `setPriceListPrices`). One revision per list. |
| `market-pricing.ts` | Public reads: `startMarketPricing` (a presence's context, read beside the route's own reads), `marketListPricesSql` (list prices folded into a SKU statement), `priceProductCards`, `priceProductSkus`. |
| `checkout-pricing.ts` | Checkout, staff orders and agents: `marketPricingMatrixSql`, `checkoutListPricesSql`, `resolveCheckoutPriceScope` (the order's market and the buyer's segments). |

## Rules

- Market and sale lists price a non-backup market (database trigger `PRICE_LIST_BACKUP_MARKET`). Segment lists may price any market and apply only to a signed-in member, never to a public read.
- A market-keyed read with no live public list and no FX policy is neutral: it returns the root's bytes and runs no extra statement.
- A presence read costs one more statement (its market's context). Cards priced from the projection cost one more while a list is live. Checkout costs nothing more; segment membership is read only when a segment list applies to the cart.
- DVC: `pl:<market>` (pricing columns, active public lists), `pl:<market>:<product>` (their prices). A list's next start or end bounds the entry (`deps.validUntil`).
- Writes to an active list, its prices and a market's pricing or currency advance the checkout authority fence.
- A market in its own currency (MARKETS-DESIGN step 6) prices in it: its list prices in that currency first, else base prices at its rate. `MarketPriceContext.money` converts shop amounts (fees, surcharges, bundle prices) for its reads; `CheckoutPriceScope.money` is the order's presentment currency.
- Limits: 100 lists, 5,000 prices per list, 5 prices per SKU per list (its price and four quantity breaks), 100 SKUs per write.
