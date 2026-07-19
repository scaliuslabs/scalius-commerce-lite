# Content and Presentation Hardening

Last reviewed: 2026-07-19

This directory is the durable audit and decision record for CMS Pages, Media,
navigation/header/footer builders, Theme, Analytics presentation, Tax settings,
and the remaining merchant-facing content/settings surfaces. Source, focused
tests, current Cloudflare state, and live browser evidence remain authoritative.

## Files

- [PAGES.md](PAGES.md) — CMS page lifecycle, publication, conflicts,
  discovery, storefront rendering, permissions, and editor workflow.
- [MEDIA.md](MEDIA.md) — R2 media authority, upload safety, references,
  folders, image/video behavior, product integration, and gallery rules.
- [NAVIGATION.md](NAVIGATION.md) — versioned menus, header/footer placements,
  typed resource links, WordPress-like builder direction, and storefront truth.
- [NAVIGATION-AUTHORITY.md](NAVIGATION-AUTHORITY.md) — normalized menu schema,
  immutable publication/placement contract, large-store paging, dependency
  generations, migration gates, and the canonical admin/public cutover.
- [HERO.md](HERO.md) — revision-guarded hero documents, safe slide links,
  explicit draft/save/conflict workflow, and storefront rendering rules.
- [HOMEPAGE-PRESENTATION.md](HOMEPAGE-PRESENTATION.md) — bounded revisioned
  category/policy composition, competitive evidence, cache authority, and the
  future typed-module extension boundary.
- [ANALYTICS.md](ANALYTICS.md) — provider readiness, safe script authority,
  scalable list/edit workflows, activation, and public injection.
- [SETTINGS.md](SETTINGS.md) — cross-settings authority map, shared workflow
  contract, buyer/operational consequences, and per-surface release proof.
- [ACTIVATION-PERMISSIONS.md](ACTIVATION-PERMISSIONS.md) — shared draft-first
  create/edit boundary for Pages, Analytics, and Discounts.
- [THEME-TAX.md](THEME-TAX.md) — tax domain strengths and workflow gaps plus a
  versioned, accessible, previewable theme model.
- [../COMMERCE-SETTINGS-BENCHMARK.md](../COMMERCE-SETTINGS-BENCHMARK.md) —
  Shopify/Vendure/Medusa benchmarks and the cross-domain replacement plan for
  Promotions, Tax, Checkout/Payments, Theme, and Account/Users.

## Shared product principles

- Dense and quiet interfaces: one obvious primary action, compact controls,
  stable placement, keyboard-complete workflows, and progressive disclosure.
- Draft-first creation, explicit readiness, truthful preview, visible dirty and
  conflict state, and retryable failures that preserve merchant input.
- One authority per fact. A control must not imply a capability that the API,
  storage model, storefront, discovery surfaces, and caches cannot honor.
- Remove obsolete aliases, compatibility branches, duplicate editor modes, and
  unused data fields when the replacement is proven.
- Destructive actions are trash-first unless the resource is a recoverable
  derived artifact. Permanent deletion requires dependency evidence and must
  never silently break a live page, product, navigation, order, or discovery
  asset.

## Active stable-release intake (2026-07-13)

The current rich-demo merchant run must prove these reported surfaces before a
stable release. This is an execution checklist, not evidence that the work is
already complete.

- **Media:** wide workspaces show at most five complete, uncropped assets per
  row. Entering selection mode starts empty; selecting every visible result is
  a separate explicit action. Verify gallery, list, filters, folders, bulk
  lifecycle, picker confirmation, image/video metadata, posters, upload retry,
  and touch/keyboard behavior on desktop and mobile.
- **Theme:** replace the current color-token utility with the versioned
  presentation workflow described in `THEME-TAX.md`: semantic brand controls,
  real storefront desktop/mobile preview, contrast diagnostics, draft/publish,
  history, and rollback. Keep the owner-approved product-page composition.
- **Account and users:** personal profile/security/sessions and store-level
  users/roles/invitations are separate authority-owned workflows. Remove
  decorative profile-card presentation, prove responsive tables/cards, and
  keep every security mutation fail-closed.
- **Discounts:** complete the typed promotion replacement in
  `../COMMERCE-SETTINGS-BENCHMARK.md`. The builder must explain automatic/code
  method, conditions, effects, targets, allocation, combinations, budgets,
  eligibility, schedule, and exact cart outcomes without exposing evaluator
  behavior checkout cannot honor.
- **Tax, checkout, and payments:** exercise every saved configuration against
  the production calculation/readiness path. Payment setup, provider health,
  test/live mode, buyer eligibility, authorization/capture/refund, and
  deactivation are distinct facts. Tax UI must lead with readiness and exact
  checkout examples while preserving the basis-point, destination, class,
  compound-layer, revision, and historical snapshot authority.
- **All remaining Settings:** compare list, view, edit, empty, loading, failure,
  permission, dirty, conflict, and mobile states against the same dense,
  outcome-led standard. A visually cleaner card is not completion when the
  underlying lifecycle or buyer projection is unproven.

### Settings navigation checkpoint (2026-07-13)

- General and Checkout sections now use validated `section` search state, so
  refresh, browser history, and copied admin links restore the merchant's
  current workspace instead of returning to the first local-only tab.
- General uses one non-wrapping mobile rail and a compact sticky desktop rail;
  the thirteen authorities no longer wrap into an unstable multi-line tab
  cloud. Checkout retains its compact mobile strip while making the same URL
  state authoritative.
- Previously visited child workspaces remain mounted during in-app section
  changes, preserving local input until the owning form's dirty/conflict
  contract handles navigation. This checkpoint does not pretend the eventual
  route split or every individual settings lifecycle is complete.
- Store URL, Currency, Media delivery, Business identity, and Security policy
  now fail closed when their authoritative read fails. They show one local
  retry state, explicitly say defaults were not assumed, and keep saving
  locked instead of presenting editable placeholder data as current settings.
- Allowed Countries now follows the same rule despite using its own country
  catalog: a failed policy read cannot become an editable empty allowlist. It
  tracks Saved/Unsaved state, offers Reset, and exposes 44 px selectable rows
  and named remove actions for touch and assistive technology.
- Cross-domain links must preserve the exact section. Delivery-provider setup,
  for example, opens Checkout directly at Delivery Locations rather than
  forcing the merchant to rediscover the referenced field.
