# Daily Essentials reference: Ghorer Bazar

Checked 2026-09-28 from the public [home](https://ghorerbazar.com/), [shop](https://ghorerbazar.com/shop/), and [Sundarban Honey product](https://ghorerbazar.com/products/sundarban-honey) pages. Live desktop and 390×844 phone captures showed the structures below; full pixel dimensions remain unverified.

- The header exposes track order, sign in, wishlist, cart, and a nested category menu. The phone footer exposes Home, Menu, Cart, Search, and Account.
- Home shows a campaign hero, featured categories, top-selling products, brands, and category-led product groups. Product cards show a full Add To Cart action; top-selling items also offer Buy now.
- Shop has category, product-flag, price, and brand filters, a product grid, sorting, and numbered results. Cards use a full-width, thin outlined Add To Cart button in the merchant primary color on white. Products with missing optional facts still need tidy cards without invented delivery or ratings.
- The product page keeps a narrow vertical thumbnail rail beside the square photo even on phones. The phone summary follows immediately with title, price, quantity, Add to Cart and Buy Now, contact actions, then details. The five bottom navigation tabs remain present without a second sticky buy bar.
- The earlier Chaldal study describes the optional compact round quick-add setting. It is not the reference for this template's default.

The template's structural defaults are checked in `fidelity-contract.test.ts`, `catalog-listing.test.ts`, and `product-card.render.test.ts`. Add measured geometry and screenshots to `scripts/storefront-fidelity/reference-metrics.json` after a repeatable capture of the live pages.
