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
- The Media library now renders five assets per desktop row and two per 390 px mobile row, preserves uncropped product/logo previews, and treats `Select` as entering an empty selection mode; `Select all shown` is an explicit separate action. A clean authenticated production read showed all nine ready assets, including the 23.56 MB video. Media and folder reads use the same-origin admin API with explicit no-store/no-cache semantics so an earlier empty navigation result is not retained.
- Media upload continuation now warns before leaving any tab with unfinished, paused, or failed resumable work and explains that the browser `File` cannot be reconstructed after the tab closes. The shared policy remains 20 MiB for images, 100 MiB for MP4/WebM, and 50 files per batch; 36 focused media tests and the coordinated package/build gates passed.
- Discounts now expose a purpose-built mobile card rather than a squeezed desktop table, with the same edit, duplicate, activation, trash, restore, and delete actions. Production showed the existing `NN7HXMAX` code with its truthful free-shipping outcome and Active lifecycle state at desktop and 390 px widths.
- The deployed discount list now groups outcome, eligibility, schedule, usage, and savings, and flags `NN7HXMAX` for review because one saved rule needs attention. Exhausted rules no longer appear Active, combined amount/quantity requirements are disclosed together, and the remaining automatic-promotion/combination/budget/CAS/allocation work is explicitly treated as a new evaluator rather than cosmetic builder switches.
- Theme and Account settings received the first professional-workspace pass. Account now separates Personal security from Store access and uses a compact profile header. Theme uses semantic color pairs and blocks essential hex pairs below 4.5:1. Live smoke caught the old Zinc muted pair at 4.4:1; the shared preset authority was corrected, the accessible Zinc revision was published through the admin workflow, and production now reports the pair at 7.0:1 with Readability `Ready`.
- Checkout readiness no longer flashes a false failure while its payment query is still loading. Production settled to Ready for payment flow, active shipping, and active delivery hierarchy; gateway cards separately expose setup, provider, and checkout state, and buyer refund-request copy makes clear that a request does not automatically approve or process a refund.
- Payment environment handling now rejects mixed Stripe test/live key pairs even during partial credential edits, exposes provider-neutral test-mode truth for Stripe, SSLCommerz, and Polar, and labels effective test gateways to buyers as non-charging. The live gateway workspace settled with Stripe, SSLCommerz, Polar, and COD all Ready/On/Visible, and the post-deploy admin/storefront console remained free of warnings and errors.
- Tax now opens with a compact operational readiness sequence instead of a decorative hero. The live disabled configuration truthfully reports zero checkout tax, identifies the Standard default class and missing active rate, and links directly to rate setup. Its Policy/Classes/Rates/Catalog/Preview rail was browser-verified as a horizontally scrollable 390 px dark-mode workspace.
- Product detail tabs were reverified without redesigning the protected product page. The deployed rail resolves below the desktop header at 125 px and, under a long-content geometry, pins at the 56 px mobile header offset with an opaque white background, no backdrop filter, and contained horizontal overscroll. The current two short demo descriptions end before natural sticky travel; the 49-section rich-store plan supplies the long-content cases.
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
- The checked-in rich-store plan now passes `pnpm demo:store --plan`: 5 categories, 50 products, 177 SKUs, 46 optioned plus 4 simple products, 237 media intents, 49 ordered additional sections, 5 collections, 18 offers, and 3 hero stories. Write mode remains disabled until the authenticated resumable API executor and rights-safe assets are complete.
- `pnpm demo:store --diff` is also implemented as a write-disabled authenticated reconciliation: hidden interactive credentials, bounded reads, exact slug/retained-ID matching, private ignored evidence exports, safe allowlisted JSONL resume metadata, and best-effort session cleanup. Apply remains fail-closed; the command intentionally was not invoked through tooling because credentials may not enter arguments, logs, or command output.
- Rights-safe media generation is in progress through the private offline staging boundary. The 87 newly generated records are now provenance-approved, visually reviewed, and normalized: 36 complete Footwear records for Vale, Monsoon, Nila, Padma, Dune, Metro, Rove, Ridge, and Aster; 39 complete Home & Living records for Mira, Soma, Noor, Jute, Luma, Kori, Dhara, Arka, and Terra; and complete four-image Kitchen & Table sets for Kansa Serve Bowl, Bela Acacia Chopping Board, and Press Glass Storage Set. Kansa has a contained primary, two construction details, and an editorial lifestyle view; Bela adds an exact reversible-product story across its grooved presentation face, integrated handhold, flat reverse, and kitchen context; Press proves the five-piece configuration, seal/latch construction, nesting behavior, and realistic meal-prep use. They preserve exact option appearance and distinct primary/variant/detail/lifestyle roles. The partial run truthfully exits 2 with `ready: false`, `staged: 87`, `missing-source-record: 150`, and zero manifest errors; the focused registration/provenance/staging gate passes 3 files and 16 tests. Rider's four existing records remain outside this count and deliberately unapproved until the retained-Media exporter proves exact live bindings and a human can supply honest ownership evidence; Halo's retained primary/video and derived poster/detail relationship remain under the same fail-closed evidence boundary. No downloaded hash alone is rights evidence, and no staged asset has been uploaded or made public yet.
- The asset boundary now enforces source-kind/license pairing, real calendar dates, generated prompt/model provenance, byte-derived SHA/MIME/dimensions, and explicit visual-rights review. Its private registration CLI refuses checked-in manifests and atomically writes only ignored `.wrangler` evidence.
- A separate Media-only bridge now requires all 237 staged records before it can upload sequentially. It keeps a 0600 resume journal, verifies remote hashes and dimensions, reuses retained Rider/Halo Media IDs exactly, records poster relationships, and has no product/publication write surface.
- Demo publication now has an explicit fail-closed lifecycle: quarantine, inactive staging, product activation, category publication, collection activation, promotion, Theme, Navigation, and heroes. Missing CAS for navigation or standalone promotions blocks those phases; the public demo CLI remains plan/diff only. The combined asset/apply/upload verification currently passes 7 files and 37 tests.
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
5. Exercise Media selection, five-column desktop density, picker capabilities,
   upload continuation, Theme and Account authority, discount creation and
   conflict recovery, every configured checkout/payment mode, tax lifecycle,
   and the corresponding buyer outcomes at desktop and 320/360/390/430 px.
   Treat any deceptive control, stale/default-on-read-failure state, page-level
   overflow, or configuration that runtime cannot honor as a release defect,
   not a cosmetic backlog item.
