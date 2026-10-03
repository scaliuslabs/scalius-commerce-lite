# Storefront

The orchestrator for the public storefront reads: the homepage, landing pages, the layout, CMS page render data, the product-page app blocks and the store shape that drives theme fit rules. It composes lower domains and adds no table. Read this before you change what a storefront page loads or how many D1 round trips it costs.

## Entries and layer

`index.ts` is the only entry. There is no `browser.ts`. It exports:

- `storefront.service.ts`: `getHomepageData`, `getLandingPageData`, `getPageRenderData`, `getLayoutData` and their result types.
- `store-shape.ts`: `selectStoreShapeCounts`, `storeShapeFromCounts`, `readStoreShape`.
- `product-apps.ts` and `app-render.ts`: `readProductAppContext`, `planPluginRenderStoreFacts`, `readPluginRenderContext`.
- `homepage-sections.ts`: `readThemeBrandAssets`, `readThemeMedia`, `HomeMediaAsset`.

Layer L10. The domain imports `analytics`, `catalog`, `categories`, `collections`, `markets`, `navigation`, `pages`, `platform`, `plugins` and `settings`. Nothing in core imports `storefront`; only API routes call it (`apps/api/src/routes/storefront.ts`, `routes/admin/settings/site.ts`, `plugins/storefront-render.ts`).

## Owns

The domain owns no table and declares no settings document. It reads the published theme (`theme_settings`, row `default`), `analytics`, `checkout_languages`, `promotions`, `media`, `categories`, `collections` and `product_buyer_state`, the active markets (`markets`, `market_countries`, `market_presences`), and the settings documents `currency`, `media`, `metaConversions`, `seo`, `business`, `security`, `policies` and `platform`.

DVC: readers declare their dependencies where they load data. The homepage declares `deps.theme()` and `deps.anyCollection()`, the layout `deps.analytics()`, `deps.theme()` and `deps.checkoutLanguages()`. The store shape declares the any-row keys of categories, brands, attributes and collections, shipping, the `emi` document and `t:product_content_blocks`. Catalogue and navigation reads add their own keys.

## Routes

All routes are in `apps/api/src/routes/storefront.ts` under `/api/v1/storefront`.

| Method and path | Note |
|-----------------|------|
| `GET /homepage` | `getHomepageData`. Takes no query string |
| `GET /landing/{slug}` | A theme landing page's sections |
| `GET /product-apps/{slug}` | `readProductAppContext`, then the apps draw the blocks |
| `GET /pages/slug/{slug}` | `getPageRenderData` |
| `GET /layout` | `getLayoutData`, plus the public Platform origins |
| `GET /batch?r=<path>&r=...` | At most 8 public reads of one page render. Each part is answered as its own GET would, from the dependency-validated cache. The batch itself is never cached |
| `GET /frontier`, `POST /frontier/check` | Cache change frontier for the storefront page cache. Authenticated with the storefront's frontier key; not public contract |
| `POST /theme-preview/resolve`, `/theme-preview/homepage`, `/theme-preview/product-apps/{slug}` | Theme preview reads |

How a page renders from one batch, the per-page API and D1 budgets and `pnpm perf:storefront` are in [`docs/STOREFRONT-PERFORMANCE.md`](../../../../../docs/STOREFRONT-PERFORMANCE.md).

## Rules

- **Two D1 round trips.** The homepage and the layout each read in two batches. `apps/api/src/storefront-render-budget.test.ts` holds both to that budget on a store whose theme uses every section type.
- **The theme says what to read.** `homeSectionRequests(theme.pages.home, theme.pages.homeMode)` (`@scalius/shared/storefront-theme`) names the lists, images, categories, collections, brands, promotions and app sections. A theme preview passes its draft's `requests` instead.
- **Homepage batch 1:** the `seo` document, the active collections and the published theme. **Batch 2:** `planCollectionProducts`, `planHomeProductLists` and `planHomeBrands` (all `catalog`), `planHomeMedia`, `planHomePromotions`, the category tiles' published categories and a product homepage's product. Every product statement is scoped to its own rows and carries a media statement for the same rows, so cards need no third round trip.
- **Homepage result:** `{ seo, sections: { lists, media, brands, promotions, categories, collections, homeProduct, apps } }`. Unset SEO copy stays null. A list with nothing to show is empty, and its section renders nothing. `homeProduct` is `{ id, slug }` only while a product homepage's product is public; the storefront then redirects `/` to it.
- **Layout batch 1:** analytics scripts, the settings documents it projects, the published theme, the active checkout language, the store shape counts, the reachable category tree, the theme's brand images, active app installations, the placed menus, the backup market's price increment and the active markets with their countries and presences (`planMarketMatrix`). **Batch 2:** the pages the linked store policies name and the resources the menu items link to (skipped when there are none).
- **Layout result:** `analytics`, `navigation`, `footerMenus`, `categoryTree`, `currency`, `theme`, `brand`, `storeShape`, `media`, `metaCapi`, `business`, `seo` (`discovery`, `returnPolicy`, `socialImage`), `cspAllowedDomains`, `storefrontCopy`, `policies`, `appScripts` and `markets` (the active presence matrix, backup first: MARKETS-DESIGN step 2). The look (logo, announcement, footer words) is the theme document and `brand`. Identity (name, phone, email, address, social links) is `business`.
- **Theme.** The storefront renders a stored theme whole or the default theme whole, never a mix. An unreadable stored theme logs a warning and renders the default.
- **Navigation failure is local.** A corrupt placement or menu logs a warning and renders without that navigation. It does not fail the page.
- **Analytics.** The layout drops scripts that are not publicly injectable and applies `shouldUsePartytown` and `processAnalyticsScript` from `analytics`.
- **Meta CAPI.** `metaCapi.browserEventsEnabled` is true only for an enabled pixel with a readable access token. The token is decrypted (with `credentialEncryptionKey`) only when the stored document turns the pixel on.
- **Apps.** App sections draw beside batch 2. A failed draw returns no section and sets `deps.validUntil` 60 seconds ahead, so the page retries.
- **Store shape.** `selectStoreShapeCounts` is one statement that joins the layout batch. Counts read at most 1,000 rows and existence checks stop at the first match. Category facts count only what a buyer can reach: a published category with all ancestors published and a public product (`product_buyer_state.is_public`).
