# Settings Surface Contract

Last reviewed: 2026-07-13

This is the execution map for merchant settings that do not already have a
more specific domain document. It records authority and release proof, not a
cosmetic backlog. Source, focused tests, current Cloudflare state, and fresh
browser/API behavior remain authoritative.

## Shared contract

- The selected workspace belongs in the URL. Refresh, browser history, and a
  copied link must restore it; a local-only tab is not navigation.
- A failed read never becomes an editable default. Preserve the last proven
  snapshot when safe, otherwise show a local Retry state and lock writes.
- A write surface exposes Saved/Unsaved, Reset or Discard, a single primary
  save, preserved input after failure, and revision/conflict handling when the
  authority supports concurrent edits.
- Provider setup, provider enablement, buyer eligibility, environment, health,
  and buyer-visible outcome are separate facts. A green credential-shape badge
  is not a connection test.
- Desktop uses a compact section rail when several authorities share a route;
  mobile uses a non-clipping horizontal rail or route rows. Child forms must
  not create page-level horizontal overflow at 320, 360, 390, or 430 px.
- Secrets and bearer values never enter URLs, screenshots, logs, copied recovery
  links, or optimistic defaults. Masked configured state is not a secret value.
- Every setting that changes buyer behavior names and verifies its storefront,
  checkout, notification, discovery, cache, or operational projection.

General and Checkout now use validated `section` search state. Store URL,
Currency, Media delivery, Business identity, Security policy, and Allowed
Countries fail closed on read failure. These are shared-shell checkpoints, not
proof that each domain below is complete.

## General settings authorities

| Section | Current authority / buyer consequence | Remaining release proof |
| --- | --- | --- |
| Header | Versioned navigation/header configuration; storefront identity, logo, menu, social links | Full tree editing, asset fit/focal behavior, draft/conflict, keyboard reorder, desktop/mobile storefront parity |
| Footer | Footer configuration and navigation/social/legal projection | Versioned write/rollback, dependency-safe links, mobile builder, buyer parity |
| SEO | D1/KV-backed discovery policy, return-policy schema, feeds, sitemap, robots, structured data | Every toggle against live XML/JSON-LD/page truth, preview/error/conflict, dark/mobile QA |
| Storefront URL | Store URL/canonical origin used by discovery and dashboard links | Absolute-URL readiness, same-origin/canonical diagnostics, cache freshness, invalid/missing origin proof |
| Email | Cloudflare Email default plus Resend fallback and encrypted provider state | Provider health/test delivery, template/result evidence, credential rotation, queue failure/recovery |
| Currency | Store currency, symbol, USD rate, and permanent lock after catalog/order facts | Exact checkout/payment/refund/invoice rounding, stale rate/error handling, migration-only currency change |
| Media delivery | Image resizing enablement, canonical CDN host, aliases, resizable-host allowlist | Production transforms for contain/cover/focal cases, huge logo/hero/product assets, invalid host/cache behavior |
| Business | Company/legal identity, address, invoice identity/copy | Validation, dirty/conflict, invoice/schema/storefront projection, logo Media-ID migration |
| Countries | Checkout/account phone-country allow/exclude policy | Public form enforcement, canonical phone identity, empty/all semantics, conflict and mobile search |
| Auth & Access | Customer account/OTP policy plus Email/SMS/WhatsApp readiness dependencies | Every channel success/failure, mandatory phone, account/guest transitions, provider circuit behavior |
| Security | Storefront CSP allowlist | Strict normalization/preview, rejection of unsafe origins, deploy/runtime header proof, lockout recovery |
| Scanner | Expiring scanner access token/QR workflow | Scope, expiry, one-device/replay behavior, revocation, audit, dark/mobile QR usability |
| Notifications | Customer/admin event channel policy and provider readiness | Event matrix, template mapping, queue/DLQ behavior, partial provider outage, exact buyer/admin delivery evidence |

## Dedicated settings routes

| Route | Owning contract | Release status |
| --- | --- | --- |
| Theme | [`THEME-TAX.md`](THEME-TAX.md) | Semantic presentation document and real preview/history remain active work |
| Account / users | [`../COMMERCE-SETTINGS-BENCHMARK.md`](../COMMERCE-SETTINGS-BENCHMARK.md) | Personal sessions are bounded and revocable; invitations/suspension/security history remain |
| Hero sliders | [`HERO.md`](HERO.md) | Versioned desktop/mobile media exists; publication and rich-demo proof continue |
| Checkout / payments | [`../CHECKOUT-FLOW-CONTRACT.md`](../CHECKOUT-FLOW-CONTRACT.md), [`../PAYMENT-METHOD-READINESS.md`](../PAYMENT-METHOD-READINESS.md) | Outcome model is live; provider probes/webhook health/rotation and full sandbox matrix remain |
| Taxes | [`THEME-TAX.md`](THEME-TAX.md), [`../TAX-LIFECYCLE-INVARIANTS.md`](../TAX-LIFECYCLE-INVARIANTS.md) | Calculation authority is strong; bulk classification/export/refund matrix remain |
| Delivery providers | Provider settings plus shipping/order fulfillment authority | Activation readiness exists; every provider needs sandbox create/status/cancel/error/retry/mobile proof |
| Fraud checker | Provider policy and checkout/order risk projection | Credential/read failure, timeout/circuit, buyer-safe fallback, false-positive/operator workflow |
| Meta CAPI | [`ANALYTICS.md`](ANALYTICS.md) | Fail-closed ingestion exists; event parity, health, rotation, circuit and consent proof remain |
| Cache | Operational cache invalidation/warming authority | Permission, scope preview, bounded purge, failure/retry, no secret/PII output, live freshness proof |

## Verification order

1. Prove read failure, permission denial, Saved/Unsaved, Reset, conflict, and
   narrow viewport behavior for every row.
2. Exercise the real buyer or operational consequence; do not accept form-save
   success as evidence of effective configuration.
3. Verify cache invalidation/warming and rollback or repair behavior.
4. Run focused tests, sequential package checks, deployment, and authenticated
   desktop/mobile smoke; append exact evidence to `catalog/LIVE-DEMO-RUN.md`.

