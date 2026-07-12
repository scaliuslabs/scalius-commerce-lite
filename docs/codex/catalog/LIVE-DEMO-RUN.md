# Catalog Live Demo Run

Last verified: 2026-07-13 (Asia/Dhaka)

This is fresh operational evidence for the disposable Scalius demo store. It records only facts needed to reproduce or safely continue the run. Production code, D1 state, and a new browser/API check remain authoritative.

## Buyer-visible demo catalog

Only these products should remain active after cleanup:

| Product | Product ID | Category | Coverage |
| --- | --- | --- | --- |
| Halo Arc Table Lamp | `prod_FOHvuxr0Hr11AA_hyLUpH` | Home & Living | Mixed image/video gallery; merchant-defined Finish and Plug options; 3 active of 4 possible SKUs; percentage SKU discount; partial exact-SKU image assignment with automatic fallback |
| Rider Court Trainers | `prod_9XNNERD2XpAOIoI1SN6gx` | Footwear | Four real product images; merchant-defined Size and Color options; 6 active SKUs; per-SKU stock; partial exact-SKU image assignment with product-primary fallback |

The product copy and image metadata came from public DummyJSON demo data and were rewritten for this store. The media library also contains a successfully uploaded 23.56 MB MP4, proving the multipart path above the old 10 MB ceiling.

Keep these categories active and published:

- Home & Living — `cat_mZl8SzAouadS92gJPIr7l`
- Footwear — `cat_CrF6miTP8nEXe8bal5X0I`

Homepage merchandising uses the active dynamic collection Curated Essentials — `XXEtmfVkKoOW6OHdliihF` — backed only by those two categories. Its featured-grid section was browser-verified with both products, real images, option-aware prices, and the Halo SKU discount.

## Browser commerce proof

Authenticated admin and storefront flows were exercised in the Abdur Rob Chrome profile.

- Buyer selected Rider Court Trainers `Size 40 / Color Sand` and added one unit to cart.
- Cart showed the correct trainer image, option labels, BDT 8,990 price, BDT 110 shipping, and BDT 9,100 total.
- COD checkout completed as order `ZUMOSE` for the demo buyer.
- The guest receipt rendered order, money, address, item, cancellation-request entry point, and browser-bound receipt guidance.
- `/admin/orders/ZUMOSE` opened the real detail page instead of redirecting to the order list.
- Inventory showed `RIDER-COURT-TRAINERS-40-SAND` as 14 on hand, 1 committed, 13 available. The other five Rider SKUs were unchanged.
- Historical order `16V71E` was moved from Processing to Cancelled through the admin lifecycle. Global committed inventory dropped from 2 to 1, proving its Nike reservation was released.

## Cleanup decisions and state

- All five obsolete collections were moved to trash through the admin bulk action.
- Thirty obsolete products were moved to trash. The active catalog now contains exactly the two media-complete products above.
- Never permanently delete `prod_KyaDjWL28lOsRaynv9oOu` (inventory movement history) or `prod_ZeaunlIJFh94Bs8NXqesN` (inventory and historical order evidence). Keep both in trash.
- A permanent-delete request for the other 31 safe trash rows returned an opaque 500 and deleted nothing. Fix and deploy the bulk-delete path before retrying; do not bypass it with raw D1 deletes.
- A bulk-trash request for the 12 obsolete active categories also returned an opaque 500 and deleted nothing. Keep Home & Living and Footwear active. After the endpoint is fixed, move the 12 legacy categories to trash, permanently delete the safe categories, and retain Shoes while audit-bound products still reference it.
- The manual collection product picker incorrectly returned category DTOs and would insert a category ID into `productIds`. The demo collection therefore uses the valid dynamic-category source. Fix the picker/query cache boundary before using manual collections.

## Required continuation checks

1. Deploy and smoke the category product-count correlation fix; Home & Living and Footwear must each show one active product.
2. Deploy and smoke exact-SKU image precedence in Google/Meta XML and UCP.
3. Deploy the product-editor coordinated save and storefront stable cart media changes, then repeat a partial-image variant cart test.
4. Fix, deploy, and retry the two failed bulk lifecycle operations above.
5. Run `pnpm release:check`; feeds, sitemap, UCP, product JSON-LD, cart, order, and inventory must agree on availability and price.
