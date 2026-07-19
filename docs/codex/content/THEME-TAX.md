# Theme and Tax Settings Audit

Last reviewed: 2026-07-19

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

This is a calculation-authority fix, not completion of the tax workspace. Bulk
classification, configuration export, and refund matrix coverage remain
follow-up work. The primary workspace section is now validated URL state.

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
  The subsequent atomic mutation and coverage-diagnostic slices protect later
  rate edits/deletes and explain saved geographic scope. Verifying the full
  refund/rounding matrix remains release work.

## Implemented tax coverage and stacking diagnostics (2026-07-13)

- Overview and Rates now share one derived coverage authority. Every class is
  labeled as all destinations, selected destinations only, no active rate, or
  exempt; selected-only and empty classes can prepare an all-destination rate
  directly from the diagnostic.
- The workspace identifies exact duplicate scopes, broad-plus-local stacking,
  and city/zone/area overlaps only when the saved delivery hierarchy proves an
  ancestor relationship. It does not infer geography from merchant labels.
- Each stacking case explains whether rates share a priority layer or apply in
  priority order, opens a saved rate for review, and links to the production
  calculator Preview. Creating or editing an active rate shows the same
  stacking consequence before save.
- Rendered details are capped at eight with an explicit hidden count and sampled
  rate references, so a misconfigured demo catalog cannot turn the overview
  into an unbounded wall of warnings.
- Merchant copy now describes checkout outcome, zero-tax destinations, and
  rates being added together. “Release-safe behavior,” configuration-version
  prose, and lifecycle implementation language were removed from the normal
  workflow.

This is a calculation-explanation tool, not a legal nexus/registration engine.

## Implemented policy-draft lifecycle (2026-07-19)

- Policy Save and Reset now follow the same saved-versus-draft contract as the
  other settings workspaces. An unchanged policy cannot create a no-op version;
  editing any policy fact enables both actions, and Reset restores the complete
  loaded version without writing.
- Leaving the page with an unsaved policy draft uses the shared navigation
  guard. A save in flight stays protected, and a successful authoritative
  refetch becomes the next draft baseline.
- Production verification changed the buyer-facing label locally, observed
  Save/Reset enable, reset it to `Tax`, and observed both actions lock again.
  The smoke intentionally performed no tax write.
Authoritative jurisdiction obligations, configuration history/export, bulk
classification, route-backed state, and the full refund matrix remain open.

## Theme: verified current scope

- The existing singleton `theme_settings.colors` column is the versioned JSON
  authority. Its legacy column name now contains one shared semantic document:
  explicit color overrides, typography, type scale, corner style, density,
  container width, and bounded button/input/listing-card styles.
- Shared code owns the defaults, enum vocabulary, legacy flat-color upgrade,
  sanitizer, palettes, and CSS-token generation. The default document mirrors
  the pre-existing storefront exactly; merely upgrading or reading a store does
  not select a new visual style.
- The admin exposes six palettes (including a true reset to store defaults),
  paired semantic color rows, and compact presentation controls. It tracks the
  complete document as one dirty/CAS unit and does not pretend token swatches
  are a storefront preview.
- Theme and Hero remain separate authorities. Theme controls allowlisted color
  tokens; Hero controls viewport media, alternative text, destination, order,
  and visibility through its own revision. Carousel overlay contrast is not
  derived from arbitrary merchant colors.

## Theme: P1/P2 gaps

1. Header/footer composition and many legacy hard-coded storefront surfaces do
   not yet consume the shared presentation contract. Supported semantics now
   reach global type/radius/page width, shared controls, and listing cards;
   page width deliberately excludes product-detail main composition.
2. Seventeen raw tokens remain too low-level for most merchants, even though
   paired semantic rows now make the current authority more understandable.
   The real storefront preview still requires a durable presentation draft.
3. Reset stages an empty object without a before/after diff. A local draft is
   protected from navigation, but it is not durable across devices or browser
   storage loss.
4. A complete real-route preview is still missing, so component coverage and
   asset transforms cannot yet be verified before publish in the editor.
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

## Decided draft, preview, history, and rollback contract (2026-07-19)

This is the implementation authority for the next Theme slice. It follows the
useful parts of Shopify's one-live-theme plus durable-draft model and
WordPress's real-frontend preview, without introducing a second rendering
engine or a free-form CSS/theme-code surface.

- Scalius has one published semantic presentation document and one shared
  durable draft. The draft has its own positive revision and records the
  published revision it was based on. Draft saves use draft-revision CAS;
  publishing requires both the exact draft revision and its exact base
  published revision. A stale draft is rebased explicitly, never silently.
- Publishing consumes the draft into a new monotonic published revision and
  records the resulting sanitized document as an immutable history entry in
  the same D1 batch. The draft then becomes clean at that published revision.
  A concurrent draft save or publish must abort the whole batch.
- Rollback does not decrement or resurrect an old revision number. It copies a
  selected immutable history document into a new published revision, records
  that new revision with `source=rollback`, and names the selected source
  revision. Cache invalidation and warm paths are identical to a normal publish.
- Existing stores are backfilled with their current published document as the
  first history fact. Actor IDs are audit references only and may be null for
  migration/system actions; deleting an administrator must not delete history.
- Preview sessions are short-lived, opaque, and snapshot one exact draft
  revision. Only a SHA-256 token hash is stored. Creating a new preview after a
  draft save is explicit, so an open review cannot change underneath someone.
- Raw preview tokens never enter a URL, log, KV key, analytics event, or cache
  key. The admin opens a bearer-free storefront handoff route, verifies the
  exact configured storefront window/origin, and transfers the token through a
  versioned `postMessage` handshake. The storefront handoff trusts only the
  configured dashboard origin and exchanges the token through a same-origin
  JSON POST for a host-only, `HttpOnly`, `Secure`, `SameSite=Lax` cookie.
  Astro's global cross-origin form protection remains enabled; invalid,
  cross-origin, or expired sessions fail closed to the published theme.
- Any request carrying the preview cookie bypasses shared HTML and layout
  caching. Preview responses are `private, no-store`, exclude analytics and
  Meta browser-event injection, and show a persistent Draft preview bar with a
  clear exit action. The buyer-visible store and crawler/discovery outputs never
  consume a draft.
- The preview shell renders the real storefront route, not a hand-built product
  card. It offers full, desktop, and mobile frames and safe route choices
  (home, search, one selected public product/category/collection/page). It does
  not permit arbitrary origins, credentials, script input, or unsafe paths.
- Theme controls continue to affect the protected product-detail page only
  through the already-supported global semantic tokens. This work does not
  restructure that page or merge Header, Footer, Navigation, Hero, or content
  authority into Theme.

Release proof must cover two-tab draft conflicts, published-base conflicts,
preview snapshot isolation, token expiry, raw-token absence from persistence
and URLs, preview-cache bypass, analytics suppression, publish freshness,
history immutability, rollback-as-new-revision, and real desktop/mobile route
rendering.

## Implemented durable Theme workspace and live preview (2026-07-19)

- D1 now owns one CAS-protected durable draft, immutable published history,
  monotonic publish/rollback revisions, and short-lived hashed preview-session
  records. Publishing and rollback invalidate the dependent API/storefront
  projections once; neither reinterprets an old revision in place.
- The admin exposes Design system, Colors, and Review & publish as URL-backed
  workspaces. Review shows an exact change ledger, real public-route/device
  preview controls, publish readiness, immutable history, and restore-as-new-
  revision behavior. Failed authority reads do not expose assumed defaults.
- The storefront preview uses one exact draft snapshot and the real storefront
  renderer. Preview-cookie requests are private/no-store, bypass shared HTML
  caches, suppress analytics/Meta browser injection, and retain the protected
  product-page composition.
- The first production smoke exposed Astro rejecting the earlier cross-site
  form POST. The final transport keeps Astro's global origin check enabled: a
  bearer-free handoff page trusts only `DASHBOARD_URL`, receives the opaque
  token through an exact-window/exact-origin versioned `postMessage`, and uses
  a same-origin JSON POST to set the secure HttpOnly cookie. Wrong-origin,
  malformed, and expired requests cannot resolve the bearer or set a cookie.
- Production storefront version `164ea7c9-78f3-4301-8249-c64593cf403b` and
  admin version `74d6cbfa-41d7-46b8-a016-94723acbbf12` were verified together.
  The dashboard opened `Draft r1 · published r5`; the preview shell rendered
  the real storefront homepage and its live catalog with no token in the URL.
  Twenty focused Theme/preview/cache/migration suites passed 115 tests, all
  relevant typechecks passed sequentially, and the full release check passed.

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

That color-authority checkpoint did not claim a semantic theme system. The next
slice below adds the shared semantic foundation while keeping preview/history as
explicit follow-up work.

## Implemented semantic presentation foundation (2026-07-13)

- The same versioned JSON row now stores one sanitized presentation document;
  no database migration or second settings authority was added. Old flat color
  JSON upgrades on read and is rewritten as the semantic shape on the next
  successful CAS publish.
- `@scalius/shared/storefront-theme` owns the actual buyer defaults and palette
  definitions. Typography, corner, density, width, and component values are
  enum-only; merchant text never becomes a font URL, selector, or arbitrary CSS.
- Token generation emits safe font stacks, type scale, radius, density, and
  container width alongside allowlisted color overrides. The layout projects
  the document as body attributes and custom properties. Global type and shared
  token radii apply consistently; page width applies to header/footer and normal
  route content while the product-detail main composition stays unchanged.
- Shared storefront buttons, fields, and textareas opt into density and safe
  style variants. Product listing cards opt into card treatment. This is a
  deliberate bounded rollout, not a claim that every legacy hard-coded card or
  raw button is already tokenized.
- The editor is a compact responsive workspace with semantic controls first,
  palette/color detail second, shared default truth, full-document dirty state,
  field-level CAS rebase, dark-mode-safe native controls, and a sticky publish
  bar. It explicitly says real route/device preview and history/rollback are not
  available instead of showing a synthetic storefront.
- Essential explicit opaque hex and OKLCH pairs are scored at 4.5:1. Existing
  untouched defaults are displayed as store defaults and are not silently
  rewritten merely to publish an unrelated semantic choice; selecting a color
  palette or editing either member makes that pair an explicit publish gate.
- Invalid semantic values in an authoritative versioned document fail the admin
  read closed. Buyer projection sanitizes/falls back to the known defaults so a
  corrupt presentation row cannot inject CSS or blank the store.

Remaining P2 work is durable drafts, real-route desktop/mobile preview,
published history/rollback, broader legacy-component adoption, and visual
coverage proving every supported semantic choice across storefront routes. The
protected product-detail composition remains out of scope for structural theme
changes.

## Shared UI direction

- Route-backed compact subsections, a persistent readiness/preview rail, one
  sticky save bar, visible dirty/conflict state, and dense tables rather than
  five large cards per conceptual layer.
- Explain outcomes in merchant language (“Customers see prices including tax” /
  “This palette fails text contrast”) while keeping technical detail in
  progressive disclosure.

## Implemented theme workspace slice (2026-07-14)

- Theme editing is now divided into URL-backed Design system, Colors, and
  Review & publish workspaces. Refresh, history, and copied links restore the
  selected workspace, while the compact horizontal rail remains usable on a
  narrow admin viewport.
- The Design system view pairs the bounded controls with an explicit coverage
  map. It distinguishes shared storefront foundations, listing-card treatment,
  and the protected product-detail boundary instead of implying every control
  redesigns every route.
- Review & publish compares this tab against the current published revision as
  an exact semantic change ledger, names the next revision a publish will
  create, and keeps contrast/invalid-color failures as a publish gate.
- A valid configured Storefront URL produces direct review links to the real
  published home and search routes. Unsafe, credential-bearing, relative, or
  unreadable URLs produce a local configuration action without disabling theme
  editing. The workspace explicitly says these links show the published
  revision and does not present them as an unpublished draft preview.
- Durable cross-device drafts, isolated draft route/device previews, revision
  history, and rollback remain platform authority work. This slice makes those
  boundaries visible; it does not simulate them in the browser or add another
  theme settings store.

## Verification bar

- Tax calculation matrix and immutable order/refund snapshot behavior across
  configuration changes; overlap/priority diagnostics and large classification
  workflows.
- Theme concurrent edit, draft preview isolation, publish/cache freshness,
  token allowlist, contrast checks, responsive real-route preview, and rollback
  to the prior published version.
