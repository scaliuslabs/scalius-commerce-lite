# Catalog Live Demo Run

Last verified: 2026-07-13 (Asia/Dhaka)

This is fresh operational evidence for the disposable Scalius demo store. It records only facts needed to reproduce or safely continue the run. Production code, D1 state, and a new browser/API check remain authoritative.

## Buyer-visible demo catalog

Only these products should remain active after cleanup:

| Product | Product ID | Category | Coverage |
| --- | --- | --- | --- |
| Halo Arc Table Lamp | `prod_FOHvuxr0Hr11AA_hyLUpH` | Home & Living | Mixed image/video gallery; merchant-defined Finish and Plug options; 3 active of 4 possible SKUs; percentage SKU discount; partial exact-SKU image assignment with automatic fallback |
| Rider Court Trainers | `prod_9XNNERD2XpAOIoI1SN6gx` | Footwear | Four real product images; merchant-defined Size and Color options; 6 active SKUs; per-SKU stock; partial exact-SKU image assignment with product-primary fallback |

The product copy and image metadata came from public DummyJSON demo data and were rewritten for this store. A 23.56 MB MP4 was successfully uploaded during the media-path proof, demonstrating the multipart path above the old 10 MB ceiling. The final curated live media library contains only the five product images plus the dedicated logo and favicon; temporary proof media was removed.

Keep these categories active and published:

- Home & Living — `cat_mZl8SzAouadS92gJPIr7l`
- Footwear — `cat_CrF6miTP8nEXe8bal5X0I`

Homepage merchandising uses the active dynamic collection Curated Essentials — `XXEtmfVkKoOW6OHdliihF` — backed only by those two categories. Its featured-grid section was browser-verified with both products, real images, option-aware prices, and the Halo SKU discount.

## Browser commerce proof

Authenticated admin and storefront flows were exercised in the Abdur Rob Chrome profile.

- Buyer selected Rider Court Trainers `Size 40 / Color Sand` and added one unit to cart.
- Cart showed the correct trainer image, option labels, BDT 8,990 price, BDT 110 shipping, and BDT 9,100 total.
- COD checkout completed again after the 2026-07-13 coordinated release as order `FWW6XI` for `Scalius Demo Buyer`.
- The guest receipt rendered order, money, address, item, cancellation-request entry point, and browser-bound receipt guidance.
- `/admin/orders/FWW6XI` opened the real detail page instead of redirecting to the order list.
- Inventory showed `RIDER-COURT-TRAINERS-40-SAND` as 14 on hand, 1 committed, 13 available. The other five Rider SKUs were unchanged.
- Historical order `16V71E` was moved from Processing to Cancelled through the admin lifecycle. Global committed inventory dropped from 2 to 1, proving its Nike reservation was released.
- After the coordinated release, Rider `Size 42 / Color Sand` was added to a fresh cart. The cart retained the exact product image and merchant option labels with a BDT 8,990 subtotal.
- The cleaned storefront homepage showed Curated Essentials with Halo and Rider only. No obsolete Nike or energy-drink card remained.
- Legacy product-photo branding was replaced with dedicated Scalius logo and favicon media. The saved D1 layout projection and a cache-bypassed storefront render both resolved the new assets with `Scalius`/`Scalius icon` alternative text.
- The legacy screenshot and flag homepage banners were replaced through the revision-aware admin workflow with Rider and Halo product media, accurate alternative text, and direct product destinations. Reload confirmed desktop hero revision 2 and a cache-bypassed storefront render showed both linked slides.
- `/admin/orders/FWW6XI` exposed pending fulfillment, COD collection controls, immutable BDT totals, the exact `40 / Sand` SKU identity, and return controls without redirecting or logging a browser error.
- Migration `0025_customer_order_ownership.sql` linked guest orders to unified CRM profiles without granting private account ownership. Production `/admin/customers` now shows FWW6XI as a Guest buyer with 1 order, BDT 0 paid spend, and the correct last-order date; its history page shows the same summary plus the BDT 9,100 pending order. The 390x844 Customers view renders a purpose-built card with readable contact, metrics, and actions.
- The first live customer-metrics projection returned zero inside batched correlated reads even though D1 held the correct CRM link and order. Customer list/history metrics now use a joined grouped aggregate, preserve net paid value after partial refunds, exclude trashed orders, and were browser-verified after redeployment.

## Cleanup decisions and state

- All five obsolete collections were moved to trash through the admin bulk action.
- Thirty obsolete products were moved to trash. The active catalog now contains exactly the two media-complete products above.
- Never permanently delete `prod_KyaDjWL28lOsRaynv9oOu` (inventory movement history) or `prod_ZeaunlIJFh94Bs8NXqesN` (inventory and historical order evidence). Keep both in trash.
- The safe permanent-delete retry exposed an ambiguous unqualified D1 history-guard join. The guard now compiles with explicit physical-table column qualification. All 31 safe obsolete products were then permanently deleted; only the two protected audit products remain in product trash.
- The 12 obsolete active categories were moved to trash atomically. Eleven safe categories were permanently deleted; Shoes remains in category trash because the protected audit products still reference it. Home & Living and Footwear are the only active categories, each with an active-product count of one.
- Category product-count SQL initially compiled an alias as a nonexistent physical table. The correlated count now reads the real `products` table with explicit column qualification, and the live list loads correctly.
- The manual collection picker no longer accepts category IDs. Its first live retry failed closed because duplicate `name` columns in the D1 batch shifted the product DTO. The joined category name now has an explicit result alias; the live picker shows exactly Halo Arc Table Lamp / Home & Living and Rider Court Trainers / Footwear.
- The live inventory projection contains 9 current SKUs only: 84 on hand, 1 committed, and 83 available. Rider 40 / Sand remains 14 on hand, 1 committed, 13 available.
- Header social links were normalized to explicit HTTPS URLs and nonblank labels (`Facebook`, `X`, `LinkedIn`, `GitHub`, `YouTube`, and `WhatsApp`) before the strict navigation validator release.

## Release proof

- Current coordinated release: API `54b33b46-c5ed-45ea-a528-df5aeccebb5d`, admin `cfd24714-499c-462c-a9ee-d0e3d95ed614`, storefront `0ffea68c-cf5c-4ac8-810c-e5c1bf7ceba2`, ops monitor `a2aed446-5e1b-4588-a568-1c0f93da3cc3`.
- Latest customer-authority release: API `f08cfa2a-5f4a-4711-9cce-eed66b377bad`, admin `936639af-1969-4d61-aa47-b2339bd237cf`; storefront and ops-monitor remain the coordinated versions above because this slice did not change either Worker.
- Migration `0025_customer_order_ownership.sql` applied successfully before the customer-authority API deployment.
- CMS page migration `0021_eminent_slayback.sql` applied successfully; the Pages admin loads without a route or API error.
- Latest API after the live D1 and media-key fixes: `6c0c3abc-01a9-4b2c-91f9-c1eefe2121a2`.
- Migrations `0022` (analytics lifecycle), `0023` (hero slider revisions), and `0024` (theme revisions) applied successfully before the current release.
- Full local release gate before deployment: 540 test files and 3,779 tests passed; TypeScript/Astro diagnostics, lint, SDK generation, and Worker binding checks passed.
- Production ops and release checks passed after all four current deployments. Discovery proof covered six sitemap checks, Google and Meta feeds with nine valid variant rows, UCP search/lookup, product JSON-LD, storefront cache headers, and auth gates. All eight queue bindings had only the intended API/ops-monitor producers and API consumers.
- The final storefront pass opened the cart in a fresh Chrome tab and exposed its screen-reader description with no console warning. The deployed Taxes rate editor also showed the deterministic priority-layer explanation and loaded without an error.
- The obsolete `storefront-test` -> `testdash` Worker chain was removed after dependency inspection. This also removed `testdash` from the payment-events, order-notifications, and auth-otp production producer lists; a subsequent queue topology check showed only the source-owned API and ops-monitor producers.
- Known external operations debt: ops-monitor email aliases are not configured, so alerts remain logs-only.

## Required continuation checks

1. Preserve the two protected trash products and Shoes category until an explicit audit-retention policy replaces them.
2. Keep the demo collection dynamic unless a manual-membership workflow is intentionally needed; the manual picker is now safe and live-verified.
3. Repeat `pnpm release:check` after any further catalog, checkout, discovery, or storefront deployment.
4. Continue the broader release goal across Media, Pages, Orders, Abandoned, Customers, Discounts, Analytics, navigation, themes, taxes, and remaining settings without changing the protected product-page visual system.
