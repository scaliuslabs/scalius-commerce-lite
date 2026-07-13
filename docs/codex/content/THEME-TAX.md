# Theme and Tax Settings Audit

Last reviewed: 2026-07-12

These settings currently have very different risk profiles. Tax has a serious
domain model behind a sprawling interface; Theme has a narrow color override
model presented as if it were a complete theme system.

## Tax: verified architecture strengths

- Store settings, tax classes, and tax rates use positive version/CAS writes.
- Rates use basis points, bounded priority, explicit jurisdiction scope,
  compound state, and active state. Scoped destinations resolve against active
  delivery-location authority.
- Class deletion is soft, versioned, and blocked by settings, rates, products,
  or SKUs. SKU classification overrides product, which overrides store default.
- Product/SKU classification writes participate in aggregate revision safety.
- Checkout quotes and saved order tax snapshots use the commerce money model;
  future configuration does not reinterpret historical orders.

## Tax: remaining workflow and verification work

- Policy, Classes, Rates, Classification, and Preview are presented as five
  equally weighted tabs. Lead with one readiness summary and the normal setup
  sequence: policy → classes/rates → exceptions → preview. Hide exception-scale
  tools until the store needs them.
- Show calculation examples beside the fields they explain: inclusive versus
  exclusive price, shipping treatment, compound ordering, and destination
  winner. The current terminology assumes tax expertise.
- Rate creation should choose a class and destination through searchable
  selectors, preview the effective hierarchy, and diagnose overlapping equal-
  priority rules before save. Priority is an advanced control, not a primary
  merchant input.
- Classification needs bulk selection/edit, compact inherited-source badges,
  URL-backed kind/search/page, and direct product/SKU links. One-row immediate
  select writes are efficient but poor for large reclassification work.
- Add a tax configuration audit/export and a test matrix covering inclusive /
  exclusive prices, shipping, exemptions, compound rates, discounts, zero /
  three-decimal currencies, refunds, and destination fallback. UI polish cannot
  substitute for calculation evidence.
- Keep the domain model. Do not replace basis points/CAS/snapshots with a
  superficially simpler percentage form.

## Implemented tax calculation hardening (2026-07-13)

- Compound calculation now treats priority as an explicit layer. Every rate at
  the same priority sees the same taxable base; a compound rate includes tax
  only from completed, strictly lower-priority layers.
- This removes a hidden dependency on random rate IDs. Previously, a compound
  rate and a standard rate at equal priority could produce different component
  amounts depending on their opaque ID sort order, contradicting the admin's
  “earlier priority” explanation.
- Exclusive and inclusive regression cases prove that equal-priority 10% and
  5% rates produce 15% total tax, while the existing lower-priority →
  higher-priority compound behavior remains unchanged. The rate editor now
  describes equal priorities as one layer.

This is a calculation-authority fix, not completion of the tax workspace. Rate
overlap diagnostics, bulk classification, configuration export, refund matrix
coverage, and route-backed tab/search state remain follow-up work.

## Theme: verified current scope

- The saved value is one sanitized `storefront_colors` object. The storefront
  injects approved CSS custom-property overrides; unsafe keys/values are
  rejected and relevant caches invalidate.
- The admin exposes five palettes and 17 individual color cards with a small
  synthetic product preview. It tracks dirty state locally.
- Theme and Hero remain separate authorities. Theme controls allowlisted color
  tokens; Hero controls viewport media, alternative text, destination, order,
  and visibility through its own revision. Carousel overlay contrast is not
  derived from arbitrary merchant colors.

## Theme: P1/P2 gaps

1. There is no version/CAS, so concurrent theme edits overwrite silently.
2. “Theme” controls colors only. Typography, type scale, radius, container
   width, button/input density, card treatment, product-card choices, and
   header/footer presentation are scattered or hard-coded.
3. Seventeen raw tokens are too low-level for most merchants and consume large
   space. Foreground pairs can be saved without contrast guidance; the preview
   is not the real storefront and cannot reveal inaccessible combinations.
4. Reset stages an empty object without explaining the effective defaults or
   showing the before/after scope. Load/save errors are page-level text and do
   not preserve/reconcile another editor's version.
5. Presets and default values are duplicated in the React component and
   storefront CSS. One shared theme schema/preset authority is required.

## Theme direction

- Introduce a versioned theme settings document with semantic high-level
  controls first: brand color, neutral style, typography, corner style, and
  density. Generate safe low-level tokens from that model.
- Advanced mode may edit semantic tokens, but every change shows automated
  contrast results and affected components. Invalid combinations are diagnosed
  before publish.
- Use Draft → Preview → Publish. Preview renders the actual storefront routes in
  an isolated draft context for desktop/mobile, without changing buyer caches.
  Publishing is expected-version guarded and invalidates/warm paths once.
- Header, footer, menus, and theme remain separable versioned documents but
  share one Presentation workspace and preview session.
- Preserve the current owner-approved storefront product-page composition;
  theme tokens may affect its global colors/type only through the same published
  theme contract.

## Implemented theme authority slice (2026-07-13)

- Migration `0024_kind_spitfire.sql` adds the singleton `theme_settings`
  document and copies any legacy `settings.theme/storefront_colors` value into
  revision 1 without deleting the legacy row.
- Reads prefer the versioned document and retain a revision-0 legacy fallback.
  First publish uses insert-on-conflict and later publishes use revision CAS, so
  two tabs cannot silently replace each other even within the same second.
- The storefront layout projection reads the same document first and falls back
  to the legacy row only when the versioned document is absent. Published color
  values continue through the shared allowlist sanitizer.
- A stale publish returns 409 before cache invalidation. The admin preserves the
  local draft, fetches the latest revision, and lets the merchant explicitly
  load that saved version or review and republish the retained draft.
- The color workspace is palette-first, keeps raw semantic tokens in collapsed
  advanced disclosure, shows published revision/dirty state in a persistent
  publish bar, and disables all mutations without `settings.general.edit`.

This slice deliberately does not claim the larger semantic theme system is
finished. Typography, density, radius, real-route isolated previews, automated
contrast enforcement, publish history, and rollback remain follow-up work.

## Shared UI direction

- Route-backed compact subsections, a persistent readiness/preview rail, one
  sticky save bar, visible dirty/conflict state, and dense tables rather than
  five large cards per conceptual layer.
- Explain outcomes in merchant language (“Customers see prices including tax” /
  “This palette fails text contrast”) while keeping technical detail in
  progressive disclosure.

## Verification bar

- Tax calculation matrix and immutable order/refund snapshot behavior across
  configuration changes; overlap/priority diagnostics and large classification
  workflows.
- Theme concurrent edit, draft preview isolation, publish/cache freshness,
  token allowlist, contrast checks, responsive real-route preview, and rollback
  to the prior published version.
