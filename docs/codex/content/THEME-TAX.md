# Theme and Tax Settings Audit

Last reviewed: 2026-07-13

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

## Implemented tax readiness slice (2026-07-13)

- The workspace now leads with the actual setup sequence: default class, active
  default-class rate, then checkout calculation. A disabled store explicitly
  says checkout records zero tax and is not misreported as a runtime failure.
- The next action opens the exact missing step. A non-exempt default with zero
  active rates goes to Rates before the merchant is encouraged to enable tax;
  exempt defaults correctly require no rate.
- The decorative hero was replaced by a compact operational header. Tax tabs
  are controlled, horizontally scrollable, and non-shrinking on mobile, so a
  readiness action and narrow viewport preserve the active workspace.

## Implemented tax activation invariant (2026-07-13)

- The D1-backed settings authority now rejects tax activation when the selected
  non-exempt default product class has no active rate. If shipping tax uses a
  separate non-exempt class, that class must also have an active rate. Exempt
  classes intentionally remain valid without a rate.
- The policy form enforces and explains the same rule before submission, and
  workspace readiness includes the effective shipping class instead of showing
  a false ready state. Disabled stores may still save incomplete configuration
  so legacy setups can be turned off and repaired safely.
- This is an activation-time guard, not a complete destination-coverage proof.
  Preventing later rate edits/deletes from invalidating an already-enabled
  configuration, diagnosing geographic gaps/overlaps, and verifying the full
  refund/rounding matrix remain release work.

## Theme: verified current scope

- The saved value is one sanitized `storefront_colors` object. The storefront
  injects approved CSS custom-property overrides; unsafe keys/values are
  rejected and relevant caches invalidate.
- The admin exposes five palettes and the 17 allowlisted tokens through paired
  semantic rows. It tracks dirty state locally and shows a token map without
  pretending that admin markup is a storefront preview.
- Theme and Hero remain separate authorities. Theme controls allowlisted color
  tokens; Hero controls viewport media, alternative text, destination, order,
  and visibility through its own revision. Carousel overlay contrast is not
  derived from arbitrary merchant colors.

## Theme: P1/P2 gaps

1. “Theme” controls colors only. Typography, type scale, radius, container
   width, button/input density, card treatment, product-card choices, and
   header/footer presentation are scattered or hard-coded.
2. Seventeen raw tokens remain too low-level for most merchants, even though
   paired semantic rows now make the current authority more understandable.
   The real storefront preview still requires a durable presentation draft.
3. Reset stages an empty object without a before/after diff. A local draft is
   protected from navigation, but it is not durable across devices or browser
   storage loss.
4. Presets and default values are still not one storefront/admin schema
   authority. They can drift until both runtimes generate tokens from shared
   semantic settings.
5. There is no published history, rollback, or isolated shareable preview.
   Conflict rebase is field-level and explicit, but cannot replace durable
   presentation revisions and a real route preview.

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
  local draft, fetches the latest revision, and blocks another publish until
  the merchant explicitly uses the latest version or rebases only this tab's
  changed fields onto it.
- The color workspace is palette-first, groups background/foreground authority
  into dense semantic pairs, shows published revision/dirty state in a
  persistent publish bar, and disables all mutations without
  `settings.general.edit`.
- Essential opaque-hex text pairs are checked against a 4.5:1 contrast floor
  before publish. Unsupported values are diagnosed at their field through the
  same shared sanitizer contract as the API. Functional CSS colors remain
  safe but explicitly unscored until the shared semantic color engine can
  normalize them.
- The misleading synthetic product preview and hard-coded light color-picker
  popover were removed. Native compact pickers work in light/dark mode, and a
  semantic token map makes the narrow scope of this editor explicit.
- A failed authoritative read no longer falls through to editable defaults.
  The page fails closed with a local retry state and states that no values were
  assumed. Exact normalized dirty comparison and the shared navigation guard
  prevent false dirty state and accidental draft loss.
- The Account administrator list may preserve its last successful rows during
  refresh failure for diagnosis, but invitations, permission edits, and removals
  stay disabled until a current authoritative read succeeds. Role selection
  separately remains fail-closed while the assignable-role read is unavailable.

This slice deliberately does not claim the larger semantic theme system is
finished. Typography, density, radius, real-route isolated previews, full
functional-color contrast normalization, publish history, and rollback remain
follow-up work.

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
