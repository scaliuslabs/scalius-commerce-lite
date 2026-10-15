# Scalius Commerce 2.0 beta

This is the beta candidate for the core contract freeze. Deployment and publication are separate from preparing the candidate. The full review, browser journey and capacity sweeps remain release evidence to collect; focused checks do not replace them.

## Core contract

- Objects replace both metaobjects and app records: typed definitions, scoped records, revisions, indexes, dashboard/API/CLI access, related records and bounded public reads.
- Custom fields can reference a declared Object type. Deleted or non-public targets resolve to null in public reads.
- Buyer extensions use the declarative `buyer.ui` function and host actions. Checkout attributes are validated, persisted and bound to quotes and retries. Account and receipt output stays private. Static checkout app blocks and `request.render` are retired.
- Shipping methods can use app-calculated courier rates. Requests have bounded deadlines and fallback policy; signed quotes bind the selected rate through checkout, including cash collection for deposits. The Bangladesh pack supplies Pathao rates.
- Theme v10 adds dynamic sources, selected custom fields on product cards and Specifications. Core and Noor share typed product/listing projections.
- Events are emitted only when an active subscriber needs the topic. The expanded catalog remains facts-only; realtime writes retain their own observer.
- Plugin preview/watch commands and a self-contained SDK package support the authoring loop. Manifest, protocol, SDK and stable-operation snapshots define the beta baseline.
- PostgreSQL order numbers use a native sequence. Free-plan operation budgets retain the 50-call invocation ceiling.

## Upgrade

Apply migrations 0154–0156 before the new application code. Use the repository deploy command when deployment is authorized.

0155 deliberately removes the disposable pre-beta metaobject/app-record tables. It also resets stored themes, drafts, history, restore points and previews: old theme versions are not upgraded on read. Reconfigure saved theme branding and landing layouts after that reset. Other catalog, order and customer data are not part of this reset.

0156 preserves existing custom-field definitions and values while expanding the type constraint. SQLite retains foreign-key enforcement throughout the rebuild; PostgreSQL changes only the constraint.

This is an intentional pre-freeze contract replacement. Existing pre-beta apps using retired storage, metaobject or static-block APIs must be rebuilt against the new SDK. Future changes to the sealed beta contract must pass the compatibility gates.

## Scope

The separate marketing campaign app and engine remain cancelled by the owner's October 13 decision. Existing consent and unsubscribe protections remain core. Marketplace, subscription billing, paid hosting and AI vendor products are separate products.

The candidate does not claim an npm publication, production deployment, full-suite pass or completed review sweep. Those outcomes must be recorded from their actual runs.

## Candidate verification — 2026-10-15

- Workspace typecheck, including Astro: passed. Dashboard lint passed; storefront lint passed with 17 warnings.
- Dashboard and storefront builds, API deployment dry run, distribution-secret checks and build canaries: passed. No production deploy ran.
- Focused contract, Object/custom-field, checkout, buyer UI, courier, theme, event and migration tests: passed after integration fixes. Native PostgreSQL sequence concurrency and upgrade/fresh-schema parity passed; migration metadata and core domain boundaries passed.
- SDK tarball installed, imported and typechecked in an external consumer. Bundled plugins were rebuilt and ABI/operation snapshots verified.
- Strict Free/Paid budget checks passed for admin listing, status changes and refunds, including isolated cold requests. Cold refunds used 47 of the 50 allowed D1 calls; the ceiling has no exceptions.
- Live messaging authorization now rejects disabled/replaced apps, banned approvers and revoked scopes; bridge and bundled/sandbox regressions passed.

Review sweeps, final composed browser journeys, full-suite/DVC race and capacity runs, deployment smokes and package publication remain separate release steps. The earlier Noor gallery passed eight scenarios at mobile and desktop widths; final integration still needs the requested review sweep.
