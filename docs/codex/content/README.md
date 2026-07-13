# Content and Presentation Hardening

Last reviewed: 2026-07-12

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
- [HERO.md](HERO.md) — revision-guarded hero documents, safe slide links,
  explicit draft/save/conflict workflow, and storefront rendering rules.
- [ANALYTICS.md](ANALYTICS.md) — provider readiness, safe script authority,
  scalable list/edit workflows, activation, and public injection.
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
