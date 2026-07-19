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

## Interface consistency audit — 2026-07-13

The remaining settings work is not an open-ended visual refresh. The current
source audit found these concrete shared-contract violations:

- Cache uses decorative gradient overview cards, a rainbow per-group style map,
  oversized headings, and explanatory architecture copy before the operator's
  actual queue failures and invalidation actions. Rebuild it around health,
  failed work, bounded group actions, and a dependency drawer using semantic
  surfaces; preserve the existing permission and DLQ authorities.
- Fraud Checker and Meta CAPI still use oversized route headers and large local
  cards. Both need the same provider outcome model as payments: setup,
  enablement, environment, health, runtime consequence, and last verified
  evidence must remain distinct. A successful form save is not provider health.
- Email status still uses one-off success styling and provider setup copy. Move
  it to the same semantic outcome and test-delivery vocabulary without exposing
  masked credentials as editable values.
- Scanner's white QR backing is intentional scan contrast, not a theme surface;
  the surrounding card, expiry, copy, regeneration, replay, and error states
  still need independent mobile/dark verification.
- Tax now keeps its validated `section` in the URL. Customer-request policy now
  exposes Saved/Unsaved, Reset, permission-aware read-only state, navigation
  protection, and a sticky mobile-safe save bar. Refund requests remain review
  requests and never trigger payment mutation automatically.
- Theme now owns one versioned semantic presentation document for type, scale,
  corners, density, content width, button/field/card style, and allowlisted
  colors. Default storefront presentation remains stable and product-detail
  composition stays protected. Real route/device draft preview, durable drafts,
  history, and rollback remain separate work rather than synthetic preview
  claims.
- Media now keeps a five-column desktop cap, zero-selected entry into bulk mode,
  explicit bulk outcomes, a mobile folder rail, and guarded metadata drafts.
  Adaptive transcoding and timed caption tracks remain platform work, not UI
  labels.
- Established administrator 2FA method changes now use an encrypted,
  password-proven challenge bound to the initiating user and session. Email
  and authenticator replacements commit only after the replacement proof,
  consume the challenge atomically, and leave the current authenticator secret
  and recovery codes untouched when setup is abandoned. Initial enrollment
  remains a separate Better Auth flow; unchallenged method switching is rejected
  once enrollment is established.
- Security origins must become structured entries, not one comma-delimited
  field. The effective policy should show platform-inherited storefront, API,
  dashboard, and configured CDN origins separately from merchant additions;
  inherited origins are trusted automatically when their canonical settings are
  valid and must not be copied into mutable merchant text.
- SEO needs an outcome-first workspace for canonical/discovery readiness,
  sitemap and feed inclusion, schema prerequisites, return-policy truth, and
  cache freshness. Each control must preview the exact public consequence and
  retain the existing fail-closed discovery invariants.
- Theme now provides real route/device preview, versioned drafts, publication
  history, rollback, and one semantic presentation document. Future work is
  composition with the separately versioned Header, Footer, Navigation, and
  Hero authorities; do not turn Theme into loose CSS knobs or redesign the
  protected product-detail composition.
- Notification policy and delivery providers are different authorities. The
  notification workspace should own event/channel rules while Firebase, email,
  SMS, and push setup live as provider readiness; duplicated Firebase controls
  across both surfaces must be consolidated without hiding delivery state.
- First-class integrations should use the provider's current official mark when
  permission and source terms allow it. Keep a durable source/license record,
  accessible text label, neutral fallback, and light/dark rendering; do not
  fetch arbitrary logo-aggregator SVGs or imply provider endorsement.

Implementation order after the current promotion/payment/account cutovers:
Cache operations, Fraud providers, Meta CAPI, Email/notification delivery, then
Scanner/security proof. Each slice must include mobile/dark/error states and the
actual operational or buyer projection before it can be called complete.

### Security and discovery decisions — 2026-07-14

- The persisted `security/csp_allowed_domains` value is merchant additions only.
  Storefront, API, dashboard/auth, canonical CDN, and public media storage come
  from deployed platform configuration and must be shown as read-only inherited
  sources. Never copy inherited values into merchant-managed settings.
- Inherited values must normalize to one exact HTTP(S) origin. Credentials,
  paths, queries, fragments, unsafe schemes, and wildcard platform values fail
  closed. HTTP remains limited to explicit loopback development origins.
- A merchant addition is one explicit source. Bare hosts canonicalize to HTTPS;
  wildcard subdomains require an explicit `*.example.com` entry and are never
  inferred from an exact host. The compatibility string is an internal storage
  detail, not the editing interface.
- The dashboard/auth origin belongs to admin-session and credentialed-request
  trust; it must not silently broaden storefront script, frame, or media policy.
  The storefront API and media origins are inherited only by the directives that
  need them.
- The current merchant additions still apply across script, connect, frame,
  image, and worker directives. The UI must state that consequence. A future
  capability-scoped policy requires a versioned authority and runtime cutover;
  do not imply per-capability isolation before it exists.
- SEO is an outcome-first workspace: on mobile the public discovery outcome
  precedes controls; on wide screens it remains beside the editor. Draft policy
  previews and published live probes are labeled as different facts so an
  unsaved switch cannot masquerade as deployed XML, feed, or schema proof.

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
| Theme | [`THEME-TAX.md`](THEME-TAX.md) | Versioned semantic presentation, real preview, publication history, and rollback are live; cross-authority composition remains |
| Account / users | [`../COMMERCE-SETTINGS-BENCHMARK.md`](../COMMERCE-SETTINGS-BENCHMARK.md) | Profile/security/team sections are URL-owned, personal sessions are bounded and revocable, and blocked setup can be resent; first-class invitations/suspension/security history remain |
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
