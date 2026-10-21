# Scalius Commerce 2.0 beta

The v2 beta core is deployed. The contract baseline is sealed in the manifest, protocol, SDK and stable-operation snapshots. This is a beta release; independent review and opt-in capacity benchmarks remain distinct from the verification below.

## Core contract

- Objects replace both metaobjects and app records: typed definitions, scoped records, revisions, indexes, dashboard/API/CLI access, related records and bounded public reads.
- Custom fields can reference a declared Object type. Deleted or non-public targets resolve to null in public reads.
- Buyer extensions are declarative storefront extensions (`storefront.extensions`, one render per UI slot) with host actions. Checkout attributes are validated, persisted and bound to quotes and retries. Account and receipt output stays private. Static checkout app blocks and `request.render` are retired.
- Shipping methods can use app-calculated courier rates. Requests have bounded deadlines and fallback policy; signed quotes bind the selected rate through checkout, including cash collection for deposits. The Bangladesh pack supplies Pathao rates.
- Theme documents (v10 added, v12 is current) carry dynamic sources, selected custom fields on product cards and Specifications; a stored older document upgrades on read through pure steps. Core and Noor share typed product/listing projections.
- Events are emitted only when an active subscriber needs the topic. The expanded catalog remains facts-only; realtime writes retain their own observer.
- Plugin preview/watch commands and a self-contained SDK package support the authoring loop. Manifest, protocol, SDK and stable-operation snapshots define the beta baseline.
- PostgreSQL order numbers use a native sequence. Free-plan operation budgets retain the 50-call invocation ceiling.

## Upgrade

Migrations 0154–0157 were applied by `pnpm run deploy` on 2026-10-15 before the new application code.

0155 deliberately removes the disposable pre-beta metaobject/app-record tables. It also reset stored themes, drafts, history, restore points and previews once, before theme upgrades existed. Since then a stored theme is never reset: a read upgrades an older version through pure `vN → vN+1` steps (`packages/shared/src/storefront-theme.md`, Compatibility), and one that cannot upgrade reads as unreadable. Other catalog, order and customer data are not part of this reset.

0156 preserves existing custom-field definitions and values while expanding the type constraint. SQLite retains foreign-key enforcement throughout the rebuild; PostgreSQL changes only the constraint.

0157 guards order search-index updates so status and inventory changes do not rewrite unchanged search terms. Measured status writes fell from 95 to 16; search edits and deletes remain indexed.

This is an intentional pre-freeze contract replacement. Existing pre-beta apps using retired storage, metaobject or static-block APIs must be rebuilt against the new SDK. Future changes to the sealed beta contract must pass the compatibility gates.

## Scope

The separate marketing campaign app and engine remain cancelled by the owner's October 13 decision. Existing consent and unsubscribe protections remain core. Marketplace, subscription billing, paid hosting and AI vendor products are separate products.

## Deployment — 2026-10-15

Source commit: `1cc060a0d` (`Verify beta journeys and fix dashboard accessibility`), including the earlier core verification repairs. Both Workers were deployed through `pnpm run deploy`, with each latest version verified at 100% and live storefront build propagation checked.

| Surface | Deployment |
| --- | --- |
| API and dashboard | `b8cfeef2-0765-4c54-b654-1fe04fce27ad` |
| Storefront | `c862342f-fcf3-4b30-8795-c7d8ccbdb741` |
| Storefront build | `src-cc667faffec45a37` |

`pnpm release:check --json` passed against api.scalius.com, dashboard.scalius.com and storefront.scalius.com with no warnings or required actions. It verified readiness, deployment identity, invalid-cookie rejection, dashboard auth, public reads, theme app availability, cache headers, all child sitemaps, both feeds, UCP search/lookup and Product JSON-LD. Desktop and 390 px product-page inspection found no horizontal overflow or browser errors.

The eight tables affected by the pre-beta reset were exported immediately before deployment. Migrations 0154–0157 also passed a disposable remote D1 rehearsal with foreign-key and search-update checks; that test database was deleted.

## Verification

- **Full suite:** the expanded run enabled native PostgreSQL and five DVC seeds: 1,805 files passed, four failed and 12 opt-in files were skipped; 15,631 tests passed, four failed and 24 were skipped. Every failing test subsequently passed. This is a full run plus targeted repairs, not a claim of a second entirely green full run.
- **Repairs:** fixed Objects workflow IDs, shared MCP schema references, redundant Object type reads, order search-index write amplification, PostgreSQL nested JSON/Object projections and stale fixtures. The Turso timeout passed in isolation; the PostgreSQL migration lock-table exhaustion passed with adequate disposable-server capacity; the historical 0152 parity test now compares its own migration boundary. The final native PostgreSQL/Object/custom-field regression run passed all 54 tests. The post-browser repair run passed 62 notification, composer, customer-card and smoke-helper tests.
- **Freshness and budgets:** all five DVC seeds reported zero findings; all six race tests passed. Strict Free/Paid D1 budget checks passed all 36 tests, with the Free 50-call ceiling unchanged. Both workerd profiles passed nine tests each. Operational order-status writes fell from 95 to 16.
- **Build and contracts:** serialized workspace typechecks, Astro checks, production builds, environment/source policies, secret/canary scans, migration metadata and ABI/operation gates passed. Dashboard initial bundles passed the existing budgets after deferring related-record rendering and removing an eager theme-editor import. API builds now clear stale generated artifacts; the measured API bundle is 14.96 MiB, including 7.77 MiB JavaScript, within unchanged limits. The SDK tarball installed, imported and typechecked in an external consumer; bundled plugins were rebuilt. No npm publication was performed.
- **Storefront gallery:** all 341 scenarios ran at 390, 768, 1280 and 1440 px. Three unnamed Noor gallery-link failures were fixed; those and two development-reload interruptions passed all five targeted reruns. All 24 packed Noor integration scenarios passed. Accessibility/layout gates have no outstanding failures; heuristic advisories are not a complete accessibility audit.
- **Local composed journeys:** COD checkout, authoritative quote, duplicate-request replay, receipt access and support request passed against a disposable database. Product rich-text save/reload and Object create/edit/save/revision/reload also passed through the real dashboard. The smoke helpers were corrected for the moved Bangladesh dataset, plural discount codes and shared Save bar.
- **Dashboard quality:** all 20 selected routes/surfaces passed at 390 and 1440 px in English and Bangla (80 variants, zero gating findings). Three routes were explicitly skipped because their menu, abandoned-checkout or app-page fixtures were absent. Shared control-name, description-tooltip, order-link target and Bangla composer-sizing findings were repaired. Heuristic language/timing/focus advisories remain separate from functional and accessibility gates.
- **Local runtime:** API, dashboard and storefront all started and answered successfully after aligning Astro’s nested Miniflare/workerd with the installed Wrangler runtime and excluding type declarations from dependency scanning. Production compatibility settings were retained.
- **Lint:** dashboard lint passed; storefront lint passed with 17 existing warnings. Oxlint passed with existing warnings.

Opt-in scale/load/noise benchmarks were not rerun. Production checks were read-only: no real payment, courier booking, OTP delivery or production order was created. Independent review sweeps, real-device accessibility and live provider transactions remain separate evidence; passing automated checks does not establish those outcomes.

## Since the baseline

Additions to the sealed contract (all additive; the snapshots were updated and reviewed):

- Deferred payment: the built-in invoice (`net_terms`), an app's `flow: "deferred"` payment provider, recorded payments against an invoice and overdue invoices (migration 0161).
- The stable app API grew from 124 to 136 operations: product create and update, gift cards (`read_gift_cards`, `write_gift_cards`), an app's own webhook endpoints (`write_webhooks`, migration 0162), and recorded payments. A money custom field or object field is `{ amountMinor, currency }` at every app boundary.
- SDK: `defineManifest` types handler contexts from the manifest; `createContractApi` checks `ctx.api.call` in tests; standalone apps are scaffolded outside the repository (`pnpm plugin create <id> --dir <folder>`) and `pnpm plugin validate` renders the storefront part.
- Agents confirm security changes (access keys, roles, webhooks, platform origins) like destructive and financial ones. `node scripts/agent-eval.mjs` runs the 30-task agent evaluation.
- `pnpm test` runs the suite in two passes (`scripts/test-runner.mjs`).
- Reference apps `plugins/volt`, `plugins/bazaar` and `plugins/sellers` (not bundled).

The contract seal (2026-10-21) fixed the app API's shape before the first release; breaks made then are recorded in `abi.breaks.json` and `stable-operations.breaks.json`:

- Apps name operations by resource and verb from one sealed table (`STABLE_APP_OPERATIONS`: `orders.get`, `fulfillments.void`); every app-facing error code is in the sealed `APP_ERROR_CODES` table with its status; a single resource answers `{ <singular>: Resource }`, every write takes `expectedRevision`, every address is `PostalAddress` (place ids under `placeIds`) and resource states are sealed enums; stable lists page by `cursor` and answer `{ <plural>, nextCursor }`; every stable instant is an ISO 8601 string; `StorefrontMoney` is `{ amountMinor, currency, formatted }`; core storefront names are snake_case (theme document v12); buyer UI is a storefront extension, not a checkout function; one lane per capability (`ctx.timeline`, `ctx.customFields`).

Additive since then (the stable app API is 144 operations):

- Events: fulfilment and refund events list their order lines; refunds are records with `refund.created` and `refund.updated` and the stable `refunds.create` / `refunds.list` (`write_refunds`, migration 0172).
- Payment port: saved methods, off-session charges, manual capture and void (`vault` and `manualCapture` capabilities, `payments.charge`, `payments.capture`, `payments.void`, `payment_methods.*`, migration 0173). Apps declare purchase options, and app discounts have classes with `combinesWith`; function carts carry the sales channel, segments, shipping facts and customer roles.
- App writes for building a store (migrations 0170 and 0171): `write_themes` and `write_navigation`, theme draft and menu operations, catalogue content by handle, `products.batch_create` and its siblings, customer roles and background jobs. An app never publishes the theme, and publishing refuses a theme that draws with an inactive app (`theme_apps_unavailable`).
- Storefront: card slots any app fills, cart drawer, cart page and checkout summary UI slots, more projection data (menu photos, skin images, SKU and EMI, child categories, header facts), deferred markup and signed-in parts.
- PostgreSQL upgrade migrations 0160, 0165 and 0173 now apply on a real server (the whole chain from 0050 was applied to a temporary PostgreSQL 15, where only 0053 needs PostgreSQL 16 for its unaliased derived tables; `postgres-migration-dialect.test.ts` keeps GLOB and trigger-WHEN subqueries out); production schema tools replay the migration chain instead of restoring the cached test image.
