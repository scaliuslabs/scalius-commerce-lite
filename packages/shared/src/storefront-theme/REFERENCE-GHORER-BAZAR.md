# Daily Essentials reference: Ghorer Bazar

Checked 2026-09-28 from the public [home](https://ghorerbazar.com/) and [shop](https://ghorerbazar.com/shop/) pages. Browser screenshots were blocked by Cloudflare, so pixel dimensions remain unverified.

- The header exposes track order, sign in, wishlist, cart, and a nested category menu. The phone footer exposes Home, Menu, Cart, Search, and Account.
- Home shows a campaign hero, featured categories, top-selling products, brands, and category-led product groups. Product cards show a full Add To Cart action; top-selling items also offer Buy now.
- Shop has category, product-flag, price, and brand filters, a product grid, sorting, and numbered results. Products with missing optional facts still need tidy cards without invented delivery or ratings.
- The earlier Chaldal study describes the optional compact round quick-add setting. It is not the reference for this template's default.

The template's structural defaults are checked in `fidelity-contract.test.ts`, `catalog-listing.test.ts`, and `product-card.render.test.ts`. Add measured geometry and screenshots to `scripts/storefront-fidelity/reference-metrics.json` when browser access is available.
