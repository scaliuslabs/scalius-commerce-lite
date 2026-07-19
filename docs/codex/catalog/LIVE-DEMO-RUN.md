# Catalog Live Demo Run

Last verified: 2026-07-19 (Asia/Dhaka)

This is fresh operational evidence for the disposable Scalius demo store. It records only facts needed to reproduce or safely continue the run. Production code, D1 state, and a new browser/API check remain authoritative.

## Rich-demo readiness milestone

The rich demo catalog is now applied and independently reconciled in production. The guarded executor verified 108 terminal commands for intent fingerprint `d37c6699938eae1db28ebf53f3823521b485d65d93d625b2eec5c963082aeaa1`. A fresh write-disabled diff then proved:

- 5 categories match; 0 update/create/conflict.
- 50 products match; 0 update/create/conflict.
- the filterable Brand attribute matches.
- 5 collections match; 0 update/create/conflict.
- 246 ready Media assets exist, including all 237 manifest intents.
- 177 sellable SKUs, 46 optioned products, 4 simple products, 49 ordered rich sections, 18 offer cases, and 3 responsive hero stories are represented by the checked-in manifest.

Private operational evidence remains ignored under `.wrangler/demo-store-apply/` and `.wrangler/demo-store-evidence/`. The latest complete apply evidence is `run-2026-07-15T14-42-45-778Z-4cf1f909`; the independent read-only evidence is `run-2026-07-15T14-46-12-389Z-a194f298`. Session cleanup returned a best-effort warning, so do not claim the short-lived remote session was explicitly deleted; no credential or cookie is stored in the repository.

### Free-delivery checkout projection (2026-07-19)

- A fresh Kori Oak Floating Shelf buyer run proved exact Walnut/Natural SKU
  media, cart creation, and the checkout summary, then exposed method cards
  showing their normal fees while the summary truthfully showed `Free`.
- Storefront `65305d28-a65b-4b8a-b091-e6d20bca76f9` now projects the same
  effective cart shipping fee into method cards, totals, discounts, abandoned
  checkout state, and payment handoff. Normal fees remain compact explanatory
  metadata when waived.
- Live production checks covered free-only, paid-only, and mixed carts; all
  three agreed across method cards and summary totals. The temporary test cart
  was cleared. Eighty-one focused tests, the 310-file Astro check, lint,
  deployment verification, cache warming, and `pnpm release:check` passed.

### Mobile header interaction checkpoint (2026-07-19)

- A 390 px production audit found that the visually closed navigation drawer
  was translated off-screen but still exposed its dialog and 14 controls to
  keyboard and assistive-technology navigation.
- Storefront `42db57b6-6e1c-4457-b4db-afd38316788b` now treats the drawer as a
  real modal interaction. Closed state is `aria-hidden` and inert; the trigger
  owns the panel and exposes its expanded state; opening focuses Close; Tab and
  Shift+Tab remain inside the drawer; Escape closes it and returns focus to the
  trigger; crossing the desktop breakpoint also releases the body scroll lock.
- Live proof covered closed, open, wrapped Shift+Tab, Escape, focus restoration,
  and exact 390 px page width without overflow. Five focused header/navigation
  tests, the 312-file Astro check, targeted lint, deployment verification,
  cache warming, and `pnpm release:check` passed.

### Payment-choice and guest-order checkpoint (2026-07-19)

- A visible 390 px guest checkout proved that the four payment choices were
  visually selectable cards but plain clickable `div` elements: they had no
  radio-group semantics, checked state, keyboard activation, or focus style.
- Storefront `b398273c-9514-4127-92c0-226fb35c3d70` now renders a named radio
  group of native button controls. The asynchronous gateway preparation path
  owns `aria-checked`, so failed preparation cannot leave a false selection;
  Space/Enter activation and focus-visible treatment come from the same cards
  without adding another checkout mode.
- Live keyboard proof moved the default selection to COD with Space, exposed
  `Place Order — Pay on Delivery`, and completed order `NFPLAV` for Noor Ceramic
  Vase at BDT 2,190 plus BDT 110 shipping. The 390 px receipt had no overflow or
  browser error, the admin order route rendered without redirect, and the guest
  buyer was linked to a unified Customer History profile with the same order.
- The checkout suite passed 66 tests, the 312-file Astro check and targeted
  lint passed, deployment verification/cache warming completed, and
  `pnpm release:check` passed.

### Customer/order time checkpoint (2026-07-19)

- The COD order above exposed a real midnight-boundary contradiction: order
  detail deliberately rendered `NFPLAV` in `Asia/Dhaka` as Jul 19 at 2:53 AM,
  while Customer History used the browser timezone and called the same order,
  customer creation, and change event Jul 18.
- Admin `92107650-cd0c-4a51-b68d-3c79e1f88d24` centralizes the current
  Bangladesh admin display boundary in `lib/admin-time.ts`. Order detail keeps
  the same formatter through a compatibility wrapper, while Customer History
  now uses the shared date/date-time projection without hydration suppression.
- Authenticated production proof showed `Customer since Jul 19, 2026`, `Last
  order placed Jul 19, 2026`, the `NFPLAV` row on Jul 19, its creation event at
  `Jul 19, 2026, 2:53 AM`, and the order detail at that identical timestamp.
  Both routes had no browser error. The exact UTC day-boundary regression plus
  route-boundary suite passed 54 tests, the Admin typecheck and targeted lint
  passed sequentially, deployment verification completed, and
  `pnpm release:check` passed.

### CMS presentation checkpoint (2026-07-19)

- Replaced the published About page's placeholder paragraph with a structured
  store story, selection principles, category context, and truthful post-order
  support summary. The page now uses one title H1, five content H2 headings, a
  reviewed 2400 × 900 featured asset, and an explicit search title and
  description.
- Production `/about` renders its featured image through the 1280 × 640
  Cloudflare cover projection, preserves the source alt text, has no horizontal
  overflow, and emits the saved title and 135-character meta description.
- Storefront version `b4517b1d-82d8-4ea3-be72-807ca117c6fe` replaces fixed
  gray/white CMS-page and embedded-product colors with the shared theme tokens.
  Embedded product thumbnails now preserve the whole product with `contain`
  transforms instead of cropping it to fill a square.
- The stale published `/home` CMS document contained literal `Hello World`
  markup even though `/` is the storefront homepage. It was moved to Draft
  through the merchant editor. Production `/home` now returns 404, `/` remains
  200, and the pages sitemap lists About, Returns, and Shipping without Home.
- The obsolete active `Lorem ipsum` GA4 record was deactivated, moved through
  the recoverable analytics lifecycle, and permanently deleted after the list
  synchronization fix was deployed and verified. No fake application-managed
  analytics configuration remains in the demo store.

### CMS lifecycle checkpoint (2026-07-19)

- Pages now expose a truthful Draft/Scheduled/Live lifecycle across the editor,
  URL-backed list filters, badges, title links, buyer links, bulk actions, and
  discovery readiness. The false public `publishedOnly` switch and merchant
  navigation-order field were removed; Navigation remains the ordering
  authority.
- Production proof created `Lifecycle proof 2026-07-19` as a future-scheduled
  page and observed a buyer 404, changed it through bulk `Publish now` and
  observed its canonical live storefront page, then trashed it and observed the
  buyer 404 again. The disposable page was permanently removed through the
  bulk confirmation boundary, leaving the demo catalog unchanged.
- Draft and Live list filters changed the canonical dashboard URL and returned
  the correct rows after client transition and direct reload. Draft rows had no
  storefront link; live rows did. Dark-mode surface tokens resolved correctly.
- API `3969d455-e245-4d6d-9beb-a6b9135aea5b`, Storefront
  `cf539699-1e75-479d-a905-10a9ca315767`, and Admin
  `e15663a6-5b84-4fbc-9302-e8d796ff27be` reached 100% production traffic.
  Core, API, Admin, and Storefront typechecks passed sequentially; the focused
  lifecycle/route/contract suite passed before deployment. A real-device mobile
  matrix remains required because the in-app Browser viewport override did not
  change its reported 1280 px viewport, despite the dedicated compact card
  implementation being present.

### Buyer-support and label-printing checkpoint (2026-07-17)

- Published `Shipping & delivery` (`/shipping-delivery`) with the current
  Standard Delivery (BDT 110), Collection Point (BDT 50), and Express Delivery
  (BDT 200) choices, without inventing delivery dates or universal coverage.
- Published `Returns & order support` (`/returns-order-support`) with the saved
  request policy: cancellation review before shipment, eligible return review
  after shipment, refund review, one active request, and no automatic approval
  or immediate inventory/payment mutation.
- Footer Navigation now has a fourth typed `Help` column referencing those two
  Page resources. Reload preserved `4 Help · 2 items`; both public pages render
  their own canonical title/H1 and the new footer links.
- Admin version `ae10969c-8564-4ef7-9f12-eab6952cc3a6` is live at 100%. The
  Barcode labels workspace retained an exact SKU in the URL, displayed its
  Code 128 identity plus `8 on hand · 8 available`, mapped the On hand shortcut
  to quantity 8, and returned to One each. The job remained read-only.
- The same deployment corrected the typed navigation destination picker:
  Category/Page sources no longer present a false empty state during initial
  loading, `Dynamic` is now `Filtered category`, and two selected Collection
  resources expose the exact `Add 2 items` action. The verification dialog was
  cancelled without changing the header.

### Hero crop-authority checkpoint (2026-07-17)

- API `99a06ae1-57fc-4ea8-a5bc-1bef6e6ca0e7`, admin
  `49253be7-f990-4824-b954-eda9e0bfd604`, and storefront
  `4fd2de3f-6cea-4dd0-89ff-0977687b12ab` are live at 100%.
- The desktop hero editor normalized the three legacy slides to center without
  changing their source assets, exposed a compact Focus popover on each real
  crop preview, and rendered the complete source image for click positioning.
  Horizontal/vertical keyboard range controls and Center reset were visible;
  the admin console had no warning or error.
- A visible revision-guarded write changed the first desktop slide from
  `50/50` to `51/50`, advanced revision `5` to `6`, and returned to **All
  changes saved**. The public homepage then delivered the matching Cloudflare
  URL with `fit=cover,gravity=0.51x0.5` and the CSS fallback
  `object-position: 51% 50%`; the storefront console had no warning or error.
- Focused proof is 32 passing tests across shared normalization/Cloudflare
  projection, core revision authority, admin workflow boundaries, public hero
  cache behavior, and the generated OpenAPI surface. Shared, core, API, admin,
  and storefront typechecks and lints all passed sequentially. The complete
  HTTP release gate then passed; the aggregate Wrangler queue-info preflight
  retained its known truncated-output failure even though `wrangler whoami`
  and each exact deployment verification succeeded.

The run exposed and fixed four reusable production/operations defects:

1. Media page-2 keyset pagination passed a JavaScript `Date` through raw SQL. API `56ae2b3b-bbba-4138-a62a-fdaa0768a904` replaced it with typed column comparators; same-second ascending/descending pagination and a live 24-to-48-item page advance pass.
2. A transient Cloudflare D1 overload returned 503 from readiness/login and caused dependent admin 500s. The Worker itself remained healthy. Reads recovered, and the Media bridge now leaves a 250 ms quiet interval between durable commands. Treat that incident as provider/database overload, not a cache or frontend deployment defect.
3. Category `/{id}/status` and `/{id}/publish-readiness` were absent from the RBAC route map even though the API routes existed. API `dc15f3b6-bdd0-4502-8cf2-f78d11f28769` authorizes them with category edit/view authority; four live readiness samples passed after deployment.
4. Apply verification now compares canonical discount zero/null representations and rich-section semantics, not provisional IDs. Resume planning treats final activation/publication as superseding earlier staging, preserves monotonic identity, prefers the freshest live or in-run revision, and still re-verifies final state idempotently. An interrupted resume was recovered without SKU, stock, media, or catalog drift.

Keep future checks strictly serial on this 16 GB host. Do not run workspace typechecks or deployments in parallel. Re-run `pnpm demo:store --diff`, `pnpm release:check`, and the relevant `pnpm ops:check` mode after catalog/API changes, then complete authenticated desktop/mobile merchant and buyer QA before declaring the broader platform goal complete.

## Buyer-visible demo catalog

The buyer-visible catalog now contains ten products in each category:

| Category | Category ID | Brand | Product count |
| --- | --- | --- | --- |
| Footwear | `cat_CrF6miTP8nEXe8bal5X0I` | Northline | 10 |
| Home & Living | `cat_mZl8SzAouadS92gJPIr7l` | Hearth & Form | 10 |
| Bags & Carry | `cat_omCePbAazVwcQk_EiG9F9` | Fieldwork | 10 |
| Kitchen & Table | `cat_OnDtPFx_9NcxR1uUZk2-G` | Common Table | 10 |
| Desk & Mobile Tech | `cat_9xgNEHjtr0rXhmdPbLWDV` | Orbit Works | 10 |

Representative coverage includes Rider Court Trainers with partial exact-SKU imagery, Vale Everyday Runners with Size/Color axes and one SKU-scoped discount, Halo Arc Table Lamp with image/video media and one omitted combination, simple products with generated/default SKU identity, zero-stock sold-out cases, product- and SKU-level fixed/percentage offers, free-delivery products, and products with multiple ordered rich sections. A missing exact SKU image intentionally falls back only to the product featured image; no axis/sibling inference or serialized image mapping is restored.

Homepage merchandising uses five active collections: New & Noteworthy (`koK4xysgKEG80rLh5PX5D`), Everyday Carry (`dRVGIixN6blpVyglB13nZ`), Home Refresh (`k-aIzpW83WwJc28n4GBXa`), Weekend Ready (`FsxykVB-cGK7MrTjy0a6y`), and Offers Worth Opening (`-4ohM04Ejx6wuMxGceltD`). Desktop and mobile hero authorities are active with three stories—The Everyday Edit, A softer home, and Carry the day—each using separate reviewed desktop/mobile media.

## Browser commerce proof

Authenticated admin and storefront flows were exercised in the Abdur Rob Chrome profile.

### Visible merchant-workflow checkpoint (2026-07-16)

The 5-category/50-product fixture is a deterministic catalog baseline, not a
substitute for merchant-workflow proof. The current visible production run uses
the Abdur Rob Chrome profile and keeps the final live write behind explicit
action-time confirmation.

- The existing `Kori Oak Floating Shelf` edit route is fully staged but remains
  unsaved. Its primary description now covers use cases, solid-oak/steel
  construction, natural material variation, both length/finish choices, wall
  suitability, included hardware, and safe installation. `Installation`, `Load
  & materials`, and `In the box` retain ordered rich content. Do not claim these
  copy changes are live until `Save changes` is explicitly confirmed and the
  post-save product/storefront reads prove them.
- Kori retains merchant-defined `Length` (`60 cm`, `90 cm`) and `Finish`
  (`Natural`, `Walnut`) axes, mapped to catalog size and color respectively.
  All four combinations remain active. Natural and Walnut SKUs use exact
  same-product images, every SKU tracks stock, and all four persisted internal
  Code 128 barcodes are present.
- The staged SKU weights are 2,800 g for both 60 cm variants and 3,900 g for
  both 90 cm variants. The live editor exposed the reusable ambiguity that the
  advanced field said only `Weight`; commit `01743f914` changes it to
  `Weight (g)`, adds a SKU-specific accessible name and example, and passes the
  focused 21-test matrix suite. That UI correction is committed but not yet
  deployed.
- Kori's saved search title/description remain valid. The expanded readiness
  rail reports canonical, product sitemap, feed image, catalog feed, Product
  schema, and Breadcrumb schema as ready; `noIndex`, sitemap exclusion, and feed
  exclusion are all off.
- The Additional Sections frame briefly exposed only its loading shell while
  the lazy chunk settled, then rendered all three saved sections without data
  loss. Treat this as a short loading-affordance opportunity, not a missing-data
  defect.
- A separate unsaved `Aranya Oak Entry Shelf` New Product tab is only a visible
  workflow exercise. It reuses Kori media/options and would incorrectly create
  a 51st duplicate-style product, so do not submit it. Close or discard it only
  with the required browser confirmation; the authoritative demo target remains
  exactly 50 products and ten per category.
- The latest read-only production sweep re-proved the Media manager at desktop:
  five assets per row, product images using contain rather than crop, `Select`
  entering with zero chosen assets, one independently selectable asset, and
  Escape returning to the library. The visible page reported 24 items in the
  first keyset page; this does not supersede the reconciled 246-ready-asset
  authority.
- Inventory loaded 177 sellable SKUs with 2,698 on hand, 2 committed, 2,696
  available, zero low-stock alerts needing review, and two sold-out SKUs. Its
  URL-addressable `variants`, `alerts`, and `movements` tabs all rendered. The
  movement ledger reported 193 verified v2 movements across 187 current or
  retained-audit SKU identities, including explicit stocktake notes and actor
  attribution.
- The Orders list retained its search/filter state in the URL, cleared back to
  two orders, and keyboard navigation opened `SSF6FY` at the real detail route.
  The detail showed immutable totals, exact Rider `41 / Sand` identity, COD,
  pending fulfillment, notification attempts, unavailable-provider readiness,
  and return eligibility without redirect or console warning/error. Computer
  Use returned a stale pre-navigation pixel capture while exposing the correct
  detail accessibility tree; the Chrome connector independently rendered the
  detail pixels and DOM, proving a capture artifact rather than a product bug.
- `SSF6FY` links to `cust_IGMsKuuzxrR7F6Qw4ySzS` Customer History. The unified
  Customers directory now visibly contains both checkout buyers as `Guest`,
  with one order each, zero paid spend for their unpaid orders, correct last
  order dates, and stable history routes. At 390×844 the table becomes two
  purpose-built cards with contact details, order/paid-spend/date metrics,
  actions, and no horizontal overflow. The inspected desktop and mobile states
  emitted no console warning/error.
- An ambient in-app screenshot initially looked horizontally cropped. An
  explicit 800 x 800 CSS viewport recheck rendered the entire 96vw picker,
  folder rail, filters, three-column result grid, and Close/Add controls without
  overflow. Treat the earlier image as unproven until the exact smaller
  breakpoint is reproduced; do not ship a speculative layout rewrite. The
  responsive picker still requires explicit 768/767 and phone-width screenshot
  evidence before release sign-off.
- The first buyer-side homepage pass exposed mixed money precision in the two
  product-card presentations: percentage discounts could render values such as
  `৳2,658.8`, while the carousel also omitted `From` for products whose SKU
  prices vary. Both presentations now use the shared ISO-aware short formatter:
  whole BDT values stay compact, fractional BDT values retain two decimals, and
  zero-/three-decimal currencies follow their saved currency code. The carousel
  now preserves the same `From` contract as the grid. The implementation and
  currency-code propagation are covered by the shared currency and storefront
  boundary tests; the repository suite passed 645 files/4,390 tests and the
  Storefront Astro check passed 306 files with zero diagnostics. Storefront
  `b7a11049-c7bd-42c8-a620-b9804d03a8a9` is live at 100%; a cache-bypassed
  browser read observed exact `৳2,658.80`, `৳1,047.20`, and `৳2,566.80`
  values plus `From ৳1,161` and `From ৳5,841` across the grid and carousel.
- A 390 x 844 buyer pass on Rider Court Trainers proved the page and cart stay
  at 390 CSS pixels with no horizontal overflow. The information rail is
  genuinely sticky: it flows before its threshold, holds 56 px below the
  measured header throughout the active details container, and releases at the
  container boundary. No protected product-page visual change was needed.
- The same pass found a hydrated accessibility mismatch: after selecting an
  exact SKU, the visible Add to Cart label changed but its accessible name still
  instructed the buyer to select an option; Buy Now was also actionable before
  an exact option combination existed. Storefront
  `eb681eb4-933e-4fb5-8589-70098c835b44` now derives both SSR and hydrated
  action states from one pure presentation helper. Before selection both
  actions are disabled with truthful guidance; after selecting Size 40 / Sand,
  the live controls expose `Add Rider Court Trainers to cart` and `Buy Rider
  Court Trainers now`, the price is `৳8,990.00`, and the Sand media ID is used
  by both the product hero and cart thumbnail. The 390 px cart opened with one
  exact option line and no browser warnings/errors. Fourteen focused product
  tests and the 308-file Storefront check passed.
- Post-deploy warming initially accepted mixed old/new `build=` response
  markers during Worker propagation and called every 200 response warmed. The
  deploy gate now reads the generated Storefront build ID, retries each critical
  HTML path until `X-Cache-Status` proves that exact build, and fails deployment
  verification if an old build or HTTP error persists. Three gate cases cover
  parsing, recovery, and terminal failure. Live checks for `/search`, Halo, and
  Rider all served `src-9043915681b4411f` after propagation.

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
- The Media library now renders five assets per desktop row and two per 390 px mobile row, preserves uncropped product/logo previews, and treats `Select` as entering an empty selection mode; `Select all shown` is an explicit separate action. A clean authenticated production read showed all nine ready assets, including the 23.56 MB video. Media and folder reads use the same-origin admin API with explicit no-store/no-cache semantics so an earlier empty navigation result is not retained.
- Media upload continuation now warns before leaving any tab with unfinished, paused, or failed resumable work and explains that the browser `File` cannot be reconstructed after the tab closes. The shared policy remains 20 MiB for images, 100 MiB for MP4/WebM, and 50 files per batch; 36 focused media tests and the coordinated package/build gates passed.
- Discounts now expose a purpose-built mobile card rather than a squeezed desktop table, with the same edit, duplicate, activation, trash, restore, and delete actions. Production showed the existing `NN7HXMAX` code with its truthful free-shipping outcome and Active lifecycle state at desktop and 390 px widths.
- The deployed discount list now groups outcome, eligibility, schedule, usage, and savings, and flags `NN7HXMAX` for review because one saved rule needs attention. Exhausted rules no longer appear Active, combined amount/quantity requirements are disclosed together, and the remaining automatic-promotion/combination/budget/CAS/allocation work is explicitly treated as a new evaluator rather than cosmetic builder switches.
- On 2026-07-19 the live review warning was traced to a legacy zero placeholder
  on that free-delivery rule. The editor now treats invisible canonicalization
  as an explicit repairable change; `NN7HXMAX` was saved through its normal
  revision contract and the warning is gone without changing the buyer-facing
  offer or minimum. The deployment also hardened route-specific error boundaries
  so an already-open admin tab can recover once from a stale lazy asset instead
  of leaving one workspace unusable after a release.
- Theme and Account settings received the first professional-workspace pass. Account now separates Personal security from Store access and uses a compact profile header. Theme uses semantic color pairs and blocks essential hex pairs below 4.5:1. Live smoke caught the old Zinc muted pair at 4.4:1; the shared preset authority was corrected, the accessible Zinc revision was published through the admin workflow, and production now reports the pair at 7.0:1 with Readability `Ready`.
- Checkout readiness no longer flashes a false failure while its payment query is still loading. Production settled to Ready for payment flow, active shipping, and active delivery hierarchy; gateway cards separately expose setup, provider, and checkout state, and buyer refund-request copy makes clear that a request does not automatically approve or process a refund.
- Payment environment handling now rejects mixed Stripe test/live key pairs even during partial credential edits, exposes provider-neutral test-mode truth for Stripe, SSLCommerz, and Polar, and labels effective test gateways to buyers as non-charging. The live gateway workspace settled with Stripe, SSLCommerz, Polar, and COD all Ready/On/Visible, and the post-deploy admin/storefront console remained free of warnings and errors.
- Tax now opens with a compact operational readiness sequence instead of a decorative hero. The live disabled configuration truthfully reports zero checkout tax, identifies the Standard default class and missing active rate, and links directly to rate setup. Its Policy/Classes/Rates/Catalog/Preview rail was browser-verified as a horizontally scrollable 390 px dark-mode workspace.
- Product detail tabs were reverified without redesigning the protected product page. The deployed rail resolves below the desktop header at 125 px and, under a long-content geometry, pins at the 56 px mobile header offset with an opaque white background, no backdrop filter, and contained horizontal overscroll. The current two short demo descriptions end before natural sticky travel; the 49-section rich-store plan supplies the long-content cases.
- The 2026-07-14 live product-media check selected Halo's video from the accessible gallery control. The CDN MP4 reached browser `readyState=4` with no media error and remained a secondary gallery item; the product image is still the primary/thumbnail authority. This is an intentional current limitation, not proof that video can be the product thumbnail.
- Hero editing and storefront rendering now share one presentation authority: desktop source target 1300×500 and mobile 640×300, both center-cropped to fill. Production showed the exact targets in their respective editor tabs while preserving the existing live carousel geometry.
- The settings-authority release was rechecked at 390×844 in the authenticated
  Abdur Rob Chrome profile. Media, Theme, Account, Discounts, Checkout flow,
  Payment gateways, Tax, Header navigation, and Analytics all stayed within the
  viewport without page-level horizontal overflow. Analytics dark-mode canvas
  and card surfaces used the shared semantic colors, and the browser was
  restored to light mode/default viewport after the read-only run.
- Media showed nine ready assets in five columns at 1440 px and two columns at
  390 px. Entering `Select` mode selected zero assets; `Select all shown` was a
  separate command. Checkout readiness settled to Ready for payment, shipping,
  and delivery location, and gateway cards exposed Setup, Provider, and
  Checkout state independently for Stripe, SSLCommerz, Polar, and COD.
- The same run identified two remaining release defects rather than hiding them
  behind the responsive smoke. Inventory still renders its 770 px desktop
  table inside a horizontal scroller at 390 px instead of a purpose-built
  mobile card workflow. The first request to `/admin/orders/FWW6XI` also hit a
  Cloudflare `D1_ERROR: internal error; reference = ...` and rendered the global
  500 page; an immediate reload returned the complete order. Commit
  `bfdf620ac` recognizes only that provider-referenced transient class and
  retries the read-only order-detail projection while leaving permanent SQL and
  constraint failures non-retryable. Its focused order/D1 tests and the new Tax
  diagnostics/copy tests pass; deployment and a live first-load retry proof are
  required in the next coordinated release.
- Guest CRM linkage remained healthy after the transient order read: the
  `cust_guest_FWW6XI` history route rendered the unified buyer profile, one
  pending BDT 9,100 order, zero paid spend, and the link back to order detail.
- The inventory and order-recovery follow-up is now deployed. API version
  `a20cd391-8c7a-4a28-a9b2-a2cd9f9c4e69` and admin version
  `a079b096-6634-44aa-8588-a09492ca10e6` include migration
  `0028_cute_ghost_rider.sql`, the purpose-built mobile inventory workflow,
  guarded transient order-detail retry, account session controls, explicit
  Media selection commands, and the payment-readiness outcome model.
- A fresh authenticated iPhone 14 Pro Max emulation at 430 x 932 proved that
  Inventory no longer exposes the desktop table or a page-level horizontal
  scroller. It renders compact SKU cards with product/SKU/options, status,
  On hand, Committed, Available, and the same Adjust action as desktop. The
  live summary was 9 SKUs, 84 on hand, 1 committed, and 83 available.
- The same phone viewport proved the Checkout workspace renders its customer
  access policy, mandatory-phone explanation, buyer-flow readiness, payment
  mode controls, and sticky save action without widening the page. No settings
  were changed during this read-only verification.
- Account Sessions was also re-read against current authority: two bounded
  sessions were shown, the current Chrome session was protected, one other
  session exposed a targeted sign-out action, and the global command was
  explicitly limited to other devices. No session was revoked during smoke.
- The Media library re-confirmed five complete `contain` thumbnails per row at
  1440 px. Entering Select showed `0 selected`, `Select all shown`, and
  `Cancel`; cancelling returned focus to the Select trigger. All nine assets,
  including the 23.56 MB MP4, remained available.
- Sequential verification for this checkpoint passed the promotion/migration,
  Media, Account, payment-readiness, Inventory, Tax, and order-recovery focused
  suites; Database, Core, API client, API, and Admin typechecks; SDK generation;
  schema generation; binding checks; remote migration; deployment health;
  `pnpm release:check`; and `pnpm ops:check --queues`. The only operations
  warning remains the documented logs-only alert-email configuration.
- The 2026-07-14 post-release browser check re-opened order `FWW6XI` directly at `/admin/orders/FWW6XI`; it rendered the order detail, payment, fulfillment, line item, and return state without redirecting to the list. `/admin/customers` simultaneously showed the linked `Scalius Demo Buyer` CRM row as `Guest`, with one order and a buyer-history route. Guest contact capture is therefore unified into the Customers directory without granting a storefront account.
- The order editor regression on `FWW6XI` was reproduced and fixed at its API contract boundary. Order form-data now supplies every SKU's `selectedOptions` array, the generated contract requires it, and the admin keeps a defensive empty-array adapter for legacy cached responses. After deployment, `/admin/orders/FWW6XI/edit` remained on the edit route and rendered the Rider line item as `Size: 40, Color: Sand` with no route error fallback. The authenticated read smoke now validates that exact nested array contract before opening browser routes.
- A separate authenticated live-browser sweep passed ten representative production documents after that fix: new order, new product, Rider edit, guest-customer history, Media, Discounts, Analytics, Account, Checkout, and Taxes. Every path retained its expected route/document, no route-owned error copy was found, and the isolated tab reported no console errors. This is bounded representative evidence, not a claim that every mutation has been exercised.
- Product editing was rechecked against the live Rider product. The merchant-defined Size and Color axes showed all six active combinations, every SKU row exposed an exact image selector, unassigned rows explicitly used the automatic product-image fallback, every row exposed an `Omit <combination>` action, and the reserved row disclosed `13 available to sell; 1 committed from 14 on hand` through a compact accessible control instead of permanent inline copy.
- The settings follow-up was verified again after deployment in fresh authenticated tabs. The SEO return-policy editor reserves a fixed 20 rem outcome rail, keeps all six controls inside a shrink-safe two-column region, reported no intersecting field rectangles, and produced no page-level horizontal overflow at 1280 px. The Media picker exposed one Close control rather than an overlapping text/X pair. The first Header Navigation workspace's permanent split map/inspector was subsequently rejected after live Shopify and current WordPress benchmarking. The deployed correction is one full-width compact hierarchy with a single inline row editor, ancestor-aware search, collapse/expand, Focus mode, and native parent/position/earlier/later/indent controls. The current persisted authority remains explicitly limited to 150 items and three levels until the accepted named-menu/placement architecture is implemented.
- A fresh product-detail tab no longer reproduced the React hydration error previously isolated to the updated-at text boundary. The Rider document retained its route, rendered the product and six SKU rows, and produced no browser console entry.
- Official first-party-sourced marks are now bundled locally for Stripe, SSLCommerz, Polar, Cloudflare, and Resend. The live Payment and Email settings rendered every expected asset with non-zero intrinsic dimensions while preserving provider names and readiness as real text. This is the first provider slice, not evidence that every remaining delivery, analytics, fraud, social, and messaging integration has been converted.
- Settings cache effects now have an explicit dependency matrix and focused tests. Email and SMS saves invalidate public checkout readiness; shipping lifecycle writes invalidate checkout and Product/Offer shipping schema projections; and the dependency map covers email, SMS, tax, and shipping-schema consumers. SMS queue dispatch no longer keeps a five-minute per-isolate credential object and instead reads/decrypts authoritative D1 settings for every send, removing the cross-isolate stale-save gap.
- The second provider-identity slice bundles 19 hash-verified first-party marks across payments, analytics, Meta CAPI, Firebase, WhatsApp, delivery, fraud, and SMS. SSLCommerz's source PNG was cropped only to its transparent alpha bounds and records both source and derivative hashes. FraudGuard remains a neutral shield because the configured `fraudguard.slope.com.bd` identity cannot be tied to the similarly named `fraudguard.shop`; no lookalike mark was shipped.
- The complete settings cache audit now records 32 mutation surfaces. Storefront URL saves clear both `gw:site_settings` and the separately read `gw:storefront_url`, and Firebase access-token KV keys include a credential fingerprint so private-key rotation cannot reuse an old project-scoped token. The known Partytown KV eventual-consistency/outbox boundary remains documented.

## Historical cleanup decisions and retained audit state

The cleanup bullets below describe the two-product proof store that preceded the 2026-07-15 rich-catalog publication. They remain useful for protected audit identities and old-order evidence, but their active-product/category/inventory counts are superseded by the current 5-category/50-product authority above.

- All five obsolete collections were moved to trash through the admin bulk action.
- Thirty obsolete products were moved to trash before the rich-catalog publication.
- Never permanently delete `prod_KyaDjWL28lOsRaynv9oOu` (inventory movement history) or `prod_ZeaunlIJFh94Bs8NXqesN` (inventory and historical order evidence). Keep both in trash.
- The safe permanent-delete retry exposed an ambiguous unqualified D1 history-guard join. The guard now compiles with explicit physical-table column qualification. All 31 safe obsolete products were then permanently deleted; only the two protected audit products remain in product trash.
- The 12 obsolete active categories were moved to trash atomically. Eleven safe categories were permanently deleted; Shoes remains in category trash because the protected audit products still reference it. Home & Living and Footwear were the only active categories at that historical checkpoint; the current five published categories are listed above.
- Category product-count SQL initially compiled an alias as a nonexistent physical table. The correlated count now reads the real `products` table with explicit column qualification, and the live list loads correctly.
- The manual collection picker no longer accepts category IDs. Its first live retry failed closed because duplicate `name` columns in the D1 batch shifted the product DTO. The joined category name now has an explicit result alias; the live picker shows exactly Halo Arc Table Lamp / Home & Living and Rider Court Trainers / Footwear.
- The historical two-product inventory projection contained 9 current SKUs: 84 on hand, 1 committed, and 83 available. Current rich-catalog inventory must be read from the live Inventory authority rather than inferred from this old count.
- Header social links were normalized to explicit HTTPS URLs and nonblank labels (`Facebook`, `X`, `LinkedIn`, `GitHub`, `YouTube`, and `WhatsApp`) before the strict navigation validator release.

## Release proof

- Rich-demo publication checkpoint: API `dc15f3b6-bdd0-4502-8cf2-f78d11f28769` is live at 100% with category publication/readiness RBAC coverage. Core and API typechecks passed sequentially; 50 focused RBAC/auth tests passed; four post-deploy `/readyz` samples returned 200. The guarded demo apply then verified 108 terminal commands, and the independent read-only diff proved 5 categories, 50 products, 1 Brand attribute, and 5 collections exactly match with zero conflicts. Full release and browser checks continue below; this checkpoint alone is not the broader platform release sign-off.

- The retained Rider/Halo media pipeline now has a fail-closed
  generated-original replacement path. The upload bridge requires exact old
  product/Media authority and complete direct/poster coverage; apply preserves
  product/SKU, option/value, inventory ledger, reservations, and exact SKU image
  semantics while retiring only the unapproved asset associations. The full
  demo-store suite passes (13 files, 98 tests) after the obsolete exact-eight
  retained export path was removed.

- Latest navigation fault-isolation correction: API
  `bbdf8d40-9844-4189-a303-e50b06b28244` and admin
  `0269a685-2d44-4cee-9274-69b0365121c4`. Storefront was not redeployed;
  the public layout projection is API-owned. The disposable store's former
  `{title, href}` Header/Footer links were migrated to typed resource/path
  targets without changing branding, social, or footer content. Persisted
  Header and Footer documents now fail independently, exact legacy documents
  normalize only in memory until an explicit save, and one unreadable section
  can no longer take down all Settings or the storefront homepage. The live
  Announcement panel changes the canonical URL to `panel=announcement` and
  survives reload. Navigation drag now uses one transformed 40%-opacity source
  row with sortable sibling displacement and no second overlay; live keyboard
  drag geometry settled into separate 44 px rows with one visible Shop label,
  then cancelled without dirtying the form. Focused navigation/settings gates
  passed 109 tests, Core/API/Admin typechecks ran sequentially, SDK generation
  completed, and `pnpm release:check` passed the storefront, discovery, feed,
  UCP, product-schema, cache, and auth surfaces. The only operations warning
  remains the documented logs-only alert-email configuration.

- Latest navigation/provider/cache correction: API
  `6fa538e5-2b3d-4728-8e3f-dbc35e283e80` and admin
  `1c93bdeb-59cf-4c1b-bbf8-523cee26b447`. Storefront was not redeployed because
  this slice changed only API, Core, and Admin code. Twelve focused files / 124
  tests, focused ESLint, and Admin/Core/API TypeScript checks passed
  sequentially. `pnpm release:check` exited successfully and
  `pnpm ops:check --queues` passed four of four readiness samples, 294 OpenAPI
  paths, current API at 100%, and the inspected queue topology; the only
  operations warning remains the documented logs-only alert-email channel.
  Authenticated production browser proof covered the inline Header Navigation
  editor, Meta CAPI, Analytics, Fraud Checker chooser, Firebase Admin Push,
  Delivery, and Payment Gateways. All expected adopted marks loaded with
  non-zero intrinsic dimensions and the inspected tab reported no console
  errors.

- Latest settings resilience release: API
  `9530f5ef-a87a-4410-8e0e-5c9b37bc28a1` and admin
  `4fa2ef7e-4a09-450f-8749-89393806fc62`. Storefront was not redeployed
  because this slice changed only API and admin code. It includes the SEO and
  Media dialog corrections, scalable Header/Footer navigation workspace,
  settings cache dependency coverage, authoritative SMS provider reads,
  product-detail hydration repair, and the first official provider-mark set.
  The integrated focused gate passed 66 tests; Admin, Core, and API
  typechecks passed sequentially; `pnpm release:check` exited successfully;
  and `pnpm ops:check --queues` passed four of four readiness samples, 294
  OpenAPI paths, the API deployment at 100%, and the inspected queue wiring.
  The only operations warning remains the explicitly unresolved logs-only
  alert-email channel.

- Latest order-contract and settings-structure release: API
  `c595593f-7caf-4865-b0b0-659cd23b7899`, admin
  `cddf06c1-fe77-4f21-94e1-7c6764823e04`, and storefront
  `efe22291-4360-4ccf-afaf-127832ca8fde`. The sequential deploy scripts
  completed without pending migrations. Post-deploy `pnpm release:check`
  exited successfully and `pnpm ops:check --queues` passed four of four deep
  readiness samples, 294 OpenAPI paths, the current API version at 100%, and
  the inspected producer/consumer wiring. The only operations warning remains
  the explicitly unresolved logs-only Cloudflare Email alert channel.

- Latest coordinated commerce release: migrations `0029_messy_silver_surfer.sql`
  and `0030_messy_ultragirl.sql` applied through the normal remote D1 path;
  API `a09d37b4-2cdc-460c-9d92-d2b29478c230`, admin
  `47d6e1bf-8c77-4435-adfa-3d61f6de21ee`, and storefront
  `f73e237c-e078-4f1a-b377-3417db387f31` deployed successfully. The sequential
  gate passed 3,737 package tests, all package typechecks, SDK generation,
  binding checks, deployment health/readiness, `pnpm release:check`, and
  `pnpm ops:check --queues`. Release discovery reported 294 OpenAPI routes,
  nine valid Google/Meta feed rows, catalog-only UCP search/lookup, and Product
  JSON-LD. The only operations warning remains the logs-only alert-email
  configuration.

- Latest inventory/account/payment-readiness and promotion-foundation release:
  API `a20cd391-8c7a-4a28-a9b2-a2cd9f9c4e69`, admin
  `a079b096-6634-44aa-8588-a09492ca10e6`. Migration
  `0028_cute_ghost_rider.sql` applied through the normal remote D1 path before
  the API deploy. Storefront was not redeployed because this checkpoint did
  not change storefront code. The typed promotion tables/evaluator remain
  dormant and legacy discount codes remain buyer authority until the atomic
  checkout/admin cutover is complete.
- Latest coordinated settings and commerce-authority release: API
  `cc745e67-945f-4485-abbe-3c5f45d3084d`, admin
  `e19e3d87-af93-439f-ab8a-46b026a118c0`, and storefront
  `a3586c0a-b17f-4828-a470-5de7ed5f11fe`. Migrations
  `0026_discount_revision.sql` and `0027_checkout_flow_revision.sql` applied
  through the normal remote D1 migration path before deployment. Discount rule
  and status writes plus checkout-flow settings now use monotonic revision/CAS
  contracts; tax enabled-readiness is preserved atomically; and Navigation,
  Analytics, Checkout, Discount, Tax, Theme, and Account surfaces include the
  current compact/mobile workflow slices. Sequential focused tests,
  package/Astro diagnostics, SDK and binding checks, production builds, remote
  migration verification, deployment verification, `pnpm release:check`, and
  `pnpm ops:check --queues` passed. Release discovery emitted nine valid
  Google and Meta feed items, UCP search/lookup resolved a sellable SKU, all
  eight production queues had the intended actors, and the only remaining ops
  warning is the already-recorded logs-only alert-email configuration.
- Current coordinated release: API `54b33b46-c5ed-45ea-a528-df5aeccebb5d`, admin `cfd24714-499c-462c-a9ee-d0e3d95ed614`, storefront `0ffea68c-cf5c-4ac8-810c-e5c1bf7ceba2`, ops monitor `a2aed446-5e1b-4588-a568-1c0f93da3cc3`.
- Latest customer-authority release: API `f08cfa2a-5f4a-4711-9cce-eed66b377bad`, admin `936639af-1969-4d61-aa47-b2339bd237cf`; storefront and ops-monitor remain the coordinated versions above because this slice did not change either Worker.
- Migration `0025_customer_order_ownership.sql` applied successfully before the customer-authority API deployment.
- CMS page migration `0021_eminent_slayback.sql` applied successfully; the Pages admin loads without a route or API error.
- Latest API after the live D1 and media-key fixes: `6c0c3abc-01a9-4b2c-91f9-c1eefe2121a2`.
- Latest admin settings/media/discount/tax release: `50d1053e-bc47-404d-8cf2-c002f4e6109a`. Latest storefront product-tab release: `37ca2b0a-cd8d-4ca7-b408-18fc1f5a06c2`. Their target-only TypeScript/Astro checks, production builds, deployment verification, authenticated desktop/mobile browser smoke, cache warming, and the repository `pnpm release:check` all passed.
- Latest payment/discount/media/hero release: API `c88b6b70-ab50-46a1-9b17-5d4c25a93b10`, admin `59daa54a-68ee-41c1-a9ad-d100b78bb52e`, storefront `aff120d8-f1fa-429f-ab0b-246518c626f3`. The sequential gate covered 138 focused tests; Shared, Core, API, Admin, and Storefront diagnostics; SDK generation; binding checks; API/Admin/Storefront production builds; deploy verification; authenticated browser smokes; and a passing post-deploy `pnpm release:check`.
- The checked-in rich-store plan passes `pnpm demo:store --plan`: 5 categories, 50 products, 177 SKUs, 46 optioned plus 4 simple products, 237 media intents, 49 ordered additional sections, 5 collections, 18 offers, and 3 hero stories. `pnpm demo:store --compile` emits the ordered lifecycle commands, and the live executor verified the final 108 terminal commands after resume reconciliation.
- `pnpm demo:store --diff` remains a write-disabled authenticated reconciliation with hidden interactive credentials, bounded reads, exact slug/retained-ID matching, ignored private evidence, safe allowlisted JSONL resume authority, and best-effort session cleanup. The 2026-07-15 post-apply diff proved 5 category, 50 product, 1 attribute, and 5 collection matches with no drift or conflicts.
- Rights-safe media preparation and publication are complete. All 237 manifest records are provenance-approved, visually reviewed, remotely hash/dimension verified, and present among 246 ready live assets; the set includes three reviewed H.264 product videos.
- The asset boundary now enforces source-kind/license pairing, real calendar dates, generated prompt/model provenance, byte-derived SHA/MIME/dimensions, and explicit visual-rights review. Its private registration CLI refuses checked-in manifests and atomically writes only ignored `.wrangler` evidence.
- The separate Media-only bridge requires all 237 staged records before upload, verifies remote hashes/dimensions and retained Rider/Halo replacement authority, records poster relationships, paces durable commands, and has no product/publication write surface. Its private readiness output is now complete and was consumed by the verified apply.
- Demo publication has an explicit fail-closed lifecycle: quarantine, inactive staging, product activation, category publication, collection activation, promotion, Theme, Navigation, and heroes. Product/category/collection/hero phases completed. Header/Footer navigation, Theme, and standalone promotion writes remain intentionally excluded where the publication intent lacks safe revision/CAS authority; they were not silently written from stale state.
- Migrations `0022` (analytics lifecycle), `0023` (hero slider revisions), and `0024` (theme revisions) applied successfully before the current release.
- Full local release gate before deployment: 540 test files and 3,779 tests passed; TypeScript/Astro diagnostics, lint, SDK generation, and Worker binding checks passed.
- Production ops and release checks passed after all four current deployments. Discovery proof covered six sitemap checks, Google and Meta feeds with nine valid variant rows, UCP search/lookup, product JSON-LD, storefront cache headers, and auth gates. All eight queue bindings had only the intended API/ops-monitor producers and API consumers.
- The final storefront pass opened the cart in a fresh Chrome tab and exposed its screen-reader description with no console warning. The deployed Taxes rate editor also showed the deterministic priority-layer explanation and loaded without an error.
- The obsolete `storefront-test` -> `testdash` Worker chain was removed after dependency inspection. This also removed `testdash` from the payment-events, order-notifications, and auth-otp production producer lists; a subsequent queue topology check showed only the source-owned API and ops-monitor producers.
- Latest navigation-source release: API
  `2931f2ad-a71d-45ac-8bf3-5d7efa5f8d8f` and admin
  `14b4cb39-58c8-4f3d-bbd8-23e0fa514dfd`. A live Computer Use run in the
  Abdur Rob Chrome profile reproduced a merchant-only defect that deterministic
  catalog seeding could not: a newly selected category was staged as “Label
  only” with “Checking resource” until the page was reloaded. Resource picker
  choices now receive an immediate admin-only `resolution` projection while
  the stable resource ID remains storage authority; server validation strips
  that projection and the central D1 resolver recomputes it on read. The
  category picker is limited to published categories, and category/product/
  collection picker previews honor valid canonical routes. After a fresh
  deployed-bundle reload, the same visible workflow staged Desk & Mobile Tech
  with its real label and `/categories/desk-mobile-tech`. Shopify's current
  menu editor was inspected read-only in the merchant's existing session: it
  keeps healthy destinations quiet and reserves row copy for an action or an
  exceptional state. The Scalius editor now follows that rule: it no longer
  exposes internal `ready` or `resource_draft_or_internal` values, and instead
  uses concise merchant-facing exceptions such as `Not public`, `In trash`,
  and `Unavailable`.
  The form is intentionally still unsaved while Computer Use is blocked by a
  locked Mac; no broken or partial navigation was published. The navigation
  suite passed 57 tests, the follow-up readiness-copy slice passed 13 focused
  tests, Core/Admin typechecks ran sequentially, and the deployments completed.
  Both exact production queue probes passed. Wrangler's aggregate queue probe
  then timed out twice despite those successful exact reads; the independent
  `pnpm release:check --skip-wrangler` product/API/storefront/discovery/UCP gate
  passed after the queue topology was verified separately.
- Demo operating rule: the guarded API executor is a reproducible bulk-fixture
  mechanism, not merchant-workflow proof. Every representative product create/
  edit, media assignment, navigation/settings publication, checkout, order,
  inventory, and mobile path must also be exercised through the visible admin
  or storefront UI. Use Computer Use for the real Chrome/profile proof and
  browser inspection only for diagnostics or repeatable assertions; never use
  a direct write to hide a broken merchant interface.
- Latest image-presentation release: admin
  `fdfc8f50-46a7-4937-a337-addd6ba31707` and storefront
  `49845ea0-772f-4ec3-bb59-6847974d0c85`. The shared optimizer no longer
  silently pre-crops unspecified assets to a square: its generic default is
  Cloudflare's non-upscaling `fit=scale-down`, while hero/social/intentional
  thumbnail crops remain explicit `cover` call sites. This keeps whole logos,
  merchant images, and inspection previews recoverable before CSS presentation.
  All 207 Shared tests passed with new default/explicit-cover/idempotence
  coverage; Shared, Admin, and Storefront checks ran sequentially; both Workers
  deployed at 100%; critical storefront pages warmed; production HTML retained
  explicit contain/cover transforms; and the 30-second read-only release gate
  passed API readiness, auth, storefront/cache headers, six sitemap checks,
  both feeds, UCP search/lookup/product, and Product JSON-LD. The visible
  Computer Use run remains paused solely because the Mac session is locked.
- Latest navigation-keyboard release: admin
  `19d49358-8c67-492f-ba1e-d5865b6e8106`. The visible Computer Use run in the
  Abdur Rob Chrome profile exposed a tree-specific defect in dnd-kit's generic
  sortable keyboard coordinates: Space/Arrow could leave a menu row colliding
  with itself instead of selecting the intended sibling insertion edge. The
  builder now uses navigation-specific coordinates constrained to the active
  sibling list; ArrowUp targets the previous sibling's before edge and
  ArrowDown targets the next sibling's after edge, while changing parents stays
  an explicit pointer or Move-dialog action. Collision-target changes also
  refresh the visible intent so the status does not briefly claim the item is
  already in place. Twenty-six focused navigation tests and the Admin typecheck
  passed sequentially. After deployment, the visible six-link draft moved
  Kitchen & Table before Desk & Mobile Tech and then restored it after Desk &
  Mobile Tech with correct preview/status text in both directions. The draft
  remains intentionally unpublished pending action-time confirmation for the
  public Save.
- Latest catalog-presentation release: admin
  `686fdfc9-9815-4ff7-8bdb-ff546a38c40d` and storefront
  `5978e08d-1939-4c06-9254-c0ef1c311503`. A fresh authenticated
  `pnpm demo:store --diff` first isolated one real content drift: the Dhara
  Cotton Throw paragraph had been repeated twelve times. The description was
  repaired through the visible product editor and the next reconciliation
  proved exact matches for all 5 categories, 50 products, 5 collections, and
  all 237 media intents with no conflicts. Product and variant imagery now
  preserves the complete merchant asset with explicit `contain` behavior in
  the admin product list/view/editor, order and discount pickers, scanner,
  storefront cart, and account/order history; editorial heroes remain
  intentional crops. Focused source-boundary tests, Admin TypeScript/lint, and
  Storefront Astro/lint checks passed sequentially. Live 390 px Chrome proof
  confirmed 50 mobile-admin products without horizontal overflow, exact
  variant images in the cart, ISO-precise fractional BDT totals
  (`৳2,658.80`, `৳5,317.60`), accessible quantity/removal controls, and no
  browser warning/error. The test cart was cleared afterward. The first
  storefront deploy verification caught a still-propagating homepage Worker
  build while product pages already served the new build; a direct cache/build
  probe recovered to `src-b7ae9c72b6606ef5`, and the required sequential
  redeploy then passed health, 100% version, and all critical cache warm checks.
- Latest customer-history release: API
  `b3839a53-241c-4ec8-9653-f1953de91e2e` and admin
  `67ab9f0f-f998-4def-9c99-b57f0ef80d9a`. Customer and order timestamps now
  share the Bangladesh admin-time boundary, so the live guest COD order
  `NFPLAV` is `Jul 19, 2026, 2:53 AM` in both order detail and customer
  history instead of appearing on different calendar days. At 390 px the
  recent-orders table is replaced by a compact semantic order-card projection;
  the desktop table remains available from the `sm` breakpoint. Production
  browser proof covered light and dark modes, exact same-tab navigation to
  `/admin/orders/NFPLAV`, one visible mobile order link, hidden desktop table,
  zero horizontal overflow, and no route error. The former client-only loading
  illusion and unbounded API read are also removed: the API independently pages
  orders at 5 by default (25 maximum) and change history at 20 by default (50
  maximum), returns exact totals/next-page state, and the UI appends only the
  requested next page with ID deduplication, pending state, and inline retry
  feedback. Five-query D1 batching plus the bounded location enrichment stays
  within the six-connection Worker ceiling. Seven focused tests, generated SDK,
  targeted lint, sequential API/Admin typechecks and deploy builds, API health/
  ready probes, and the deployed 390 px browser smoke all passed.
  Migration `0034_lively_lifeguard.sql` replaced the redundant single-column
  customer indexes with `customer_id + created_at` history ordering and
  `customer_id + deleted_at + created_at` active-order ordering; it applied
  successfully before the final API deployment.
- Known external operations debt: ops-monitor email aliases are not configured, so alerts remain logs-only.

### Barcode batch-composition checkpoint (2026-07-19)

- Admin `f0bc4467-df7e-40a4-93e4-2fae9bf40231` is live at 100%. The shared
  Barcode labels workspace now orders physical output as selected, by product
  and variant, or by SKU without rewriting exact URL/catalog identities.
- Authenticated production proof cleared a prior job, selected Dhara before
  Aster, changed the output order, and observed Aster before Dhara in the paper
  preview. Setting Dhara to zero exposed one bounded cleanup action; removing it
  retained the exact Aster SKU and a truthful `1 label · 1 page` job. Output
  order survived reload as a workstation preference.
- This keeps one row action and one batch composer instead of introducing a
  second immediate-print path or a blocking wizard. The A4/plain-paper, custom
  stock, thermal, partially used sheet, test print, alignment, and native
  Print/Save as PDF paths remain unchanged.
- The focused 17-test model suite, targeted lint, sequential Admin typecheck,
  production build/deploy, and full `pnpm release:check` passed. The only live
  warning remains the previously recorded logs-only ops-monitor email channel.

### Storefront identity checkpoint (2026-07-19)

- The real SEO settings workflow replaced the stale project marketing title
  with shopper-facing demo identity: fallback title `Scalius Market`, homepage
  title `Scalius Market | Thoughtful Everyday Essentials`, and a bounded search
  summary describing the five-category assortment and Bangladesh delivery.
  The public `/api/v1/seo` projection returned all three exact values after the
  save, proving settings invalidation rather than a database-only edit.
- Storefront `89ea5a82-3105-4811-9623-ea5971195d6a` is live at 100% with build
  `src-286196bf4730a444`. The homepage now emits one semantic, visually hidden
  H1 from the saved storefront title. It deliberately prefers shopper brand
  identity over Business `companyName`/`legalName`; those fields remain the
  authority for legal organization and seller schema.
- Production HTML and browser proof matched the exact title, description, and
  `Scalius Market` H1, retained three large hero images and the five rich
  collection groups, and measured `1280 px` content inside a `1280 px` viewport
  with no horizontal overflow. The focused 7-test boundary suite, targeted
  lint, Astro diagnostics (`312` files, zero errors/warnings/hints), sequential
  production build/deploy, cache warm, and full `pnpm release:check` passed.

### Media route-state checkpoint (2026-07-19)

- Admin `2ffe166f-5299-4670-bca0-02341c97b39f` is live at 100%. The standalone
  Media manager now stores safe folder, kind, sort, search, and Library/Trash
  state in one canonical URL. Default and invalid values disappear; selection,
  uploads, preview drafts, and picker-dialog state remain intentionally local.
- Authenticated production proof deep-linked to
  `?kind=video&sort=name-asc`, restored the four real MP4 assets in order,
  narrowed to the 23.56 MiB cafeteria video, and retained that exact scope on
  reload. Unfiled and Trash transitions were restored through Back/Forward, a
  missing folder-shaped ID repaired to All assets, and the base URL still
  entered selection mode with zero selected, a separate `Select all shown`,
  five desktop columns, and no horizontal overflow.
- The 54-test Media suite, route-state normalization/controlled-hook coverage,
  targeted lint, sequential Admin typecheck, production build, and deployment
  verification passed. Folder URL repair is guarded by a successful folder
  read, so transient API failure cannot silently discard the address. The full
  `pnpm release:check` subsequently passed; only the already recorded logs-only
  ops-monitor email-channel warnings remain.

### Normalized navigation release checkpoint (2026-07-19)

- Commits `2c83b00b8`, `83a0d170e`, and `5729861c4` replace embedded
  header/footer link arrays with named, revisioned draft menus, immutable
  publications, typed resource destinations, and independent storefront
  placements. API `78823abf-e412-4d37-b181-5954c16c8c76` and Admin
  `36ab46c7-38ba-4a7e-938f-42ad90a129db` are live at 100%.
- Production-browser proof opened all five migrated menus with correct item and
  location counts; Locations showed Header plus four ordered footer columns;
  History showed the current and prior immutable revisions; and URL state
  restored each panel on reload.
- A real pointer drag nested Footwear under Home & Living while every unrelated
  row remained visible. The destination expanded immediately after drop. The
  explicit row actions then outdented and restored the original order, which
  was republished at revision 9 so the demo was not left dirty.
- Commit `5aea11546` completed the non-drag exact-placement path. In production,
  `Move…` opened with the current Top level / position 1 state, offered only
  depth-safe parents with resulting levels, moved Footwear to position 1 inside
  Home & Living, and immediately showed the expanded destination. The same
  dialog restored Top level / position 1 and the original demo order was
  republished at revision 12. The dashboard console stayed clean.
- The normalized navigation suite (28 tests), focused dialog/API/service
  coverage (11 tests), targeted lint, sequential Core/API/API-client/Admin
  typechecks, sequential API/Admin deployments, and `pnpm release:check` all
  passed after the exact-placement cutover.
- The public homepage rendered the normalized header destinations and the
  Shop, Collections, Company, and Help footer menus with current category,
  collection, page, and account routes. Dashboard and storefront consoles were
  clean. Header/footer presentation settings now link to the dedicated
  Navigation workspace instead of owning a second menu editor.
- Migration `0037_thick_ikaris.sql` repaired the earlier sparse footer
  placement coordinates into slots 0–3 and added a database check. Four
  migration-chain tests, 14 focused navigation tests, sequential Database,
  Admin, and API typechecks, targeted lint, D1 migration, and deploy readiness
  all passed.

### Item-level return lifecycle checkpoint (2026-07-19)

- API `404a7a71-a268-43b1-93c3-6faa37cd853c` and Admin
  `a4ec0a7d-877b-4e45-a8a0-b077351fc577` are live at 100%. The existing demo
  order `3EFMCF` was created, fulfilled with the own-courier path, and then
  exercised through request, approval, physical receipt, and exact restock in
  the visible merchant UI.
- The first approval attempt exposed a real D1 500: three return transaction
  paths emitted invalid double-wrapped `EXISTS ((select ...))` guards. All seven
  affected predicates now use Drizzle's native `exists()` expression. A real
  SQLite integration test executes approval, cancellation, and receipt,
  including damaged receipt without restock.
- Production approval closed its dialog and left
  `ARKA-ROUND-WALL-MIRROR-60-CM-BRASS` at 7 on hand / 0 committed / 7
  available. Receiving one sellable unit completed return
  `ret_sQED4QK7x32iNHVZMDAE`, moved the order from Shipped to Returned, kept its
  COD payment Unpaid with no refund, and restored the SKU to 8 / 0 / 8. The
  inventory movement view shows the order-linked 7 to 8 edge, and D1 shows
  committed create/approve/receive commands plus an immutable receipt carrying
  the inventory movement reference.
- Return dialogs now distinguish Cancel from the icon-only Close action, and
  the fulfillment, order-status, and delivery-provider selectors expose stable
  accessible names. Three Core integration tests, seven focused Admin tests,
  targeted lint, sequential Core/API/Admin typechecks, sequential deployments,
  API readiness, and the full `pnpm release:check` passed. The only release
  warning remains the previously recorded logs-only ops-monitor email channel.

### Collection publication and homepage placement checkpoint (2026-07-19)

- Collection publication and homepage composition are now separate facts.
  `isActive` keeps a collection page publicly reachable; the normalized
  `config.showOnHomepage` boolean controls only the storefront homepage. The
  editor exposes that choice progressively and the list marks placed
  collections without adding another wide table column.
- API `edcf24e2-1527-4ba2-97ae-e9918e5aeade`, Admin
  `14ce364a-ef44-4c40-a6ce-0299c1c002d9`, and Storefront
  `fc20ade7-a45a-4d5d-bfae-82538f2a8585` are live at 100%. The real admin
  saved New & Noteworthy, Everyday Carry, and Home Refresh as the only homepage
  sections. Curated Essentials, Weekend Ready, and Offers Worth Opening remain
  published but unplaced.
- The authenticated production diff proved 5 categories, 50 products, 1
  attribute, and 5 manifest collections all matched with zero updates, creates,
  or conflicts; 246 ready media assets cover 237 manifest intents. Evidence is
  in `.wrangler/demo-store-evidence/run-2026-07-19T04-29-23-467Z-d417018c`.
- The public homepage API returned exactly the three placed collections with
  12, 8, and 8 products. The public collection listing still returned all six
  published collections, and direct storefront requests for all three
  intentionally unplaced collection pages returned 200. The deployed desktop
  homepage rendered only those three section headings; a real 390 px viewport
  rendered the same three headings with `390 px` content inside a `390 px`
  viewport and no horizontal overflow.
- The sequential Storefront Astro check completed 321 files with zero errors,
  warnings, or hints; deployment health and critical cache warming passed.
  `pnpm ops:check` passed API health, four readiness samples, 318 OpenAPI paths,
  bindings, queues, and deployment state. `pnpm release:check` then passed the
  dashboard auth gate, storefront/cache behavior, discovery XML and feeds,
  UCP catalog discovery, and a live Product schema route. The only warning is
  the already-recorded logs-only ops-monitor email channel.

### Homepage presentation checkpoint (2026-07-19)

- Homepage composition now has one bounded, revisioned settings document rather
  than inferring every module from published catalog rows. The initial document
  owns an ordered category rail (twelve exact category IDs maximum) and a
  delivery/returns strip whose copy is derived only from active shipping and
  saved return-policy authorities. Hero stories, collection placement, and
  Theme styling remain independent owners.
- Migration `0038_last_sentinel.sql` added the normalized document and positive
  revision authority without changing existing header, footer, checkout, or
  site identity. API `7a02c683-6e83-41cb-9084-810f587227a8`, Admin
  `7929c8a5-33de-4bee-b53f-155d35a51ffb`, and Storefront
  `28e9445f-d891-4cb4-bc30-d074de32a974` are live at 100%. The first visible
  merchant read exposed a missing RBAC route mapping; the endpoint failed
  closed, was covered with a focused authorization test, and the API was
  redeployed before any settings write.
- The real admin enabled the rail and policy strip, ordered Footwear, Home &
  Living, Bags & Carry, Kitchen & Table, and Desk & Mobile Tech, and saved from
  revision 1 to 2. The public API returned those exact five names in order,
  exactly New & Noteworthy, Everyday Carry, and Home Refresh as collection
  sections, and one truthful delivery fact. It omitted a returns claim because
  no enabled return-policy authority exists.
- Public category resolution is a bounded exact-ID `json_each()` lookup inside
  the first D1 batch, so a selected category cannot disappear when the catalog
  grows past 100 categories. Production browser geometry proved a 390 px
  internal snap rail with no page overflow and a five-card 1280 px grid with no
  page overflow. Shared parsing, migration, revision/CAS, storefront boundary,
  cache invalidation, and RBAC tests all passed; targeted lint and sequential
  Core/API/Admin/Storefront type diagnostics were clean.

### Cart pre-hydration safety checkpoint (2026-07-19)

- Storefront `5b2bee34-3953-43b1-a8cc-8d1fdfa48bd9` is live at 100%. The
  server-rendered cart now exposes only a compact loading state while browser
  storage is unread: the totals, discount controls, checkout form, and submit
  action remain hidden or disabled until an exact stored cart has rendered.
  JavaScript-disabled buyers receive an explicit recovery message instead of a
  deceptive zero-value checkout.
- The server-projected checkout language is reused by the cart client, removing
  the duplicate language request from the critical hydration path. A real
  browser session restored Dhara Cotton Throw / Sand with its exact
  `৳2,658.80` subtotal, `৳110` shipping, and `৳2,768.80` total; removing it
  produced the truthful empty-cart state while keeping both operational panels
  hidden and the submit action disabled.
- The raw production HTML proved `data-cart-ready="false"`, an aria-busy
  loading region, hidden summary/checkout panels, and a disabled submit button.
  After hydration the live DOM proved ready/item state, visible exact totals,
  and no false zero-value intermediate state. Twenty focused cart tests,
  targeted lint, the sequential 323-file Storefront Astro check, deployment,
  and `pnpm release:check` passed.

### Media picker lifecycle checkpoint (2026-07-19)

- Admin `59ca36a8-6294-4e83-bd73-0b540ef37d50` is live at 100%. The reusable
  Media picker now has one non-lazy owner for both the Radix dialog root and its
  trigger. The lazy child owns content only; dismissing resets visibility and
  unmounts the picker subtree so stale internal selection/dialog state cannot
  survive into the next open.
- A fresh authenticated Header Branding run proved the shared single-picker
  contract in production: the dialog count moved from zero to one, one image
  selection updated the unsaved logo draft and returned the count to zero, the
  explicit Close action independently returned it to zero, and Discard restored
  the saved Scalius logo without a settings write. The standalone Media route
  remains a separate explicit workflow: Select starts with zero assets and
  Select all shown is never implied.
- The focused Media suite passes 57 tests across 16 files, including a mounted
  lazy-picker/caller-rerender regression test. Targeted lint and the sequential
  Admin typecheck, production build, upload, and deployment verification passed.

### Account profile and setup-recovery checkpoint (2026-07-19)

- API `e5ddc7bc-33ed-4f8b-8235-b906784f93f9` and Admin
  `f947b7fa-478d-4414-8c16-eae043a3a453` are live at 100%.
- Profile is now the default URL-owned Account section and contains the compact
  identity editor. Two-factor, Password, Sessions, Administrators, and Roles no
  longer repeat that card. Unknown sections normalize back to Profile.
- Administrators still in the forced password-setup state can receive a new
  one-use setup email from the team workspace. Ready accounts, non-admin
  principals, and insufficient permissions fail closed; provider failures do
  not expose recipient or provider details.
- The authenticated production DOM proved `section=profile` renders Profile
  without the 2FA workspace, `section=team` renders all four administrators
  without the personal Profile card, and an unknown section replaces its URL
  value with `section=profile`.
- Six focused files passed 82 tests. API and Admin typechecks, SDK generation,
  and both sequential production deployments passed. No setup email was sent
  during the live smoke because every existing demo administrator is already
  beyond password setup.

### Discount create-route checkpoint (2026-07-19)

- Admin `668b3516-2a52-4143-94c3-88915ac5540e` is live at 100%. The selected
  discount outcome is now validated URL state rather than component memory.
- A fresh production direct link to `?type=amount_off_order` opened the order
  builder without the type chooser, retained that builder after a full reload,
  and **Change type** removed only `type` while restoring the chooser.
- Eighteen focused discount-builder/model/validation tests, targeted lint, and
  the sequential Admin typecheck and deployment passed. This fixes workflow
  continuity; it does not claim that the legacy code builder has become the
  future automatic/stacking/campaign promotion builder.

### Tax policy-draft checkpoint (2026-07-19)

- Admin `b22826c4-6ce4-4991-887c-bceb79679e91` is live at 100%. The Tax Policy
  workspace now distinguishes the saved version from a local draft, blocks
  no-op version writes, provides Reset, and uses the shared unsaved-navigation
  guard.
- Authenticated production verification changed the buyer-facing label to a
  local `VAT` draft, observed Save and Reset enable, then reset it to the saved
  `Tax` value and observed both actions disable. No production tax mutation was
  performed.
- Twenty-five focused Tax form/readiness/workspace tests, targeted lint, and
  the sequential Admin typecheck and deployment passed.

### Shared form and Analytics draft checkpoint (2026-07-19)

- The current production authority still contains the intended rich baseline:
  5 categories with exactly 10 products each, 50 products, 177 sellable SKUs,
  46 optioned products, 4 simple products, 49 rich additional-description
  sections, 5 manifest collections, 3 responsive hero stories, and 246 ready
  Media assets covering 237 manifest intents.
- The empty Analytics list is intentional: it no longer fabricates provider
  setup for visual fullness. Its create route did expose shared form slop—an
  enabled untouched action and duplicate “new” copy—and therefore became the
  next merchant-workflow repair.
- Admin `f545db93-6b63-46e2-8a34-b9aab9e670af` is live at 100%. Singular form
  labels now produce **Create analytics integration** and **Add a new analytics
  integration to your store**. Shared form and sticky-save paths require a
  dirty draft before submitting.
- Authenticated production verification proved the untouched **Create draft**
  action is disabled, becomes enabled after editing the integration name, and
  returns to disabled after a full reload. No analytics integration was
  created. Eighteen focused tests, targeted lint, and the sequential Admin
  typecheck passed.

### Incomplete-order workspace checkpoint (2026-07-19)

- Admin `85db75f6-652d-430a-9793-4433e69e14a5` is live at 100%. Incomplete
  Orders now owns search, pagination, page size, sort field, and sort order in
  validated URL state. Selection is cleared whenever that result identity
  changes, and an out-of-range copied page repairs to the real last page.
- A first live build exposed a Worker-SSR `Invalid URL` failure because the
  legacy query used browser-relative `fetch`. The final build replaced it with
  the server-safe admin API function and was redeployed before commit. Read
  failure now remains visibly distinct from a valid empty result.
- A copied `+880 1700 000019`/customer-ascending/10-row URL restored the exact
  result and sort after full reload. Selecting one record enabled the bulk
  action; moving to page 2 cleared it. Opening `page=999` normalized to page 3
  of 3 with records visible. No recovery record was deleted.
- Rough `item(s)` and `checkout(s)` copy was removed in favor of natural count
  grammar. Fifty-nine focused tests, targeted lint, the sequential Admin
  typecheck, deployment, and authenticated browser checks passed.

### Fresh catalog reconciliation and barcode-output checkpoint (2026-07-19)

- A new authenticated read-only reconciliation at
  `.wrangler/demo-store-evidence/run-2026-07-19T18-07-08-696Z-5ff28928`
  matched all 5 manifest categories, all 50 products, the catalog attribute,
  and all 5 planned merchandising collections with zero drift or conflict.
  The Media authority still contains 246 assets. `Curated Essentials` remains
  an intentional extra collection because the typed Header **Shop** item owns
  that destination; it is not a homepage section.
- The first pass found a repeated Soma Handloom Cushion Cover description. It
  was corrected through the authenticated product editor and re-read cleanly
  at aggregate revision 6. This was a real merchant-workflow correction, not a
  direct production-data shortcut.
- Better Auth rejected both operations-script sign-out requests with HTTP 415
  because they omitted the JSON media type. The demo reconciliation and admin
  read-check clients now send an explicit empty JSON body; the second live run
  closed its session with HTTP 200. Twenty-seven focused operations-script
  tests passed.
- The deployed Barcode labels workspace was rechecked with a saved long Code
  128 SKU. The narrow A4 cut sheet failed closed with a truthful physical-width
  diagnostic; **Use A4 adhesive** selected the first compatible format and
  enabled output. `Available` produced 8 labels from the visible `8 on hand ·
  8 available` facts, cell 5 skipped four used sheet positions, and the exact
  SKU stayed in the URL. Reload kept the workstation format but correctly reset
  the job-local count to one and the used-sheet offset to a fresh sheet.
- The same label job remained usable at 390 × 844 with no horizontal overflow
  and a fixed **Test** / **Print / PDF** action bar. Browser console/error output
  was empty. The focused barcode model and read-only inventory projection
  suites passed 39 tests. The full decision and competitive boundary remain in
  [BARCODE-LABEL-PRINTING.md](BARCODE-LABEL-PRINTING.md); neither an immediate
  row print nor a blocking wizard should replace the shared progressive job.

### Storefront image and social-accessibility checkpoint (2026-07-20)

- The live rich homepage was measured at 1440 × 1000 and 390 × 844 before
  editing. Both widths had zero horizontal overflow and no browser console or
  page errors. Responsive hero sources resolved to the intended 1300 × 500 and
  640 × 300 cover transforms; the merchant focal point remained in the first
  desktop story. Catalog cards and logos continued to use non-cropping
  `contain` transforms, while the portrait category rail alone used deliberate
  editorial `cover` crops. No image-fit policy change was justified by the
  rendered evidence.
- The accessibility tree did expose a shared renderer defect: icon-only social
  links announced the image alt and hidden label together (`X X`, `LinkedIn
  LinkedIn`, and similar). Header, mobile-menu, and both Footer renderers now
  give the anchor one explicit accessible name and make the visual image or
  fallback glyph decorative. The Footer logo destination independently
  announces **Go to homepage** instead of inheriting a media filename.
- Storefront version `ca75d2e7-7866-4a02-a2ab-47fbe4620ce7`, build
  `src-c23dd03c4356a166`, is live at 100%. Post-deploy desktop and mobile
  accessibility snapshots exposed each social destination exactly once, the
  Footer home link had the intended name, both layouts retained zero overflow,
  and browser console/error output remained empty. Ten focused presentation
  and accessibility tests, targeted lint, and the sequential 326-file Astro
  check passed before deployment.

## Required continuation checks

1. Preserve the two protected trash products and Shoes category until an explicit audit-retention policy replaces them.
2. Keep the demo collection dynamic unless a manual-membership workflow is intentionally needed; the manual picker is now safe and live-verified.
3. Repeat `pnpm release:check` after any further catalog, checkout, discovery, or storefront deployment.
4. Continue the broader release goal across Media, Pages, Orders, Abandoned, Customers, Discounts, Analytics, navigation, themes, taxes, and remaining settings without changing the protected product-page visual system.
5. Exercise Media selection, five-column desktop density, picker capabilities,
   upload continuation, Theme and Account authority, discount creation and
   conflict recovery, every configured checkout/payment mode, tax lifecycle,
   and the corresponding buyer outcomes at desktop and 320/360/390/430 px.
   Treat any deceptive control, stale/default-on-read-failure state, page-level
   overflow, or configuration that runtime cannot honor as a release defect,
   not a cosmetic backlog item.
