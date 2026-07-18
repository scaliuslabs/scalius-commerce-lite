# Analytics Administration Decisions

Last reviewed: 2026-07-13

This document owns the merchant analytics-script workflow, safe browser
injection contract, provider readiness, and the boundary with Meta CAPI. Source,
focused tests, current D1 state, and live browser evidence remain authoritative.

## Product job

The Analytics page is an operations signal board, not a code-snippet archive. A
merchant should be able to answer three questions quickly: what is configured,
what is loading on buyer pages, and what needs attention before activation.
Executable source belongs only in the edit workflow.

## Implemented authority

- `analytics` rows have a positive monotonic `revision` and nullable
  `deleted_at` from migration `0022_greedy_lucky_pierre.sql`.
- Create defaults to an inactive draft. Edit, activate, deactivate, trash,
  restore, and permanent delete require the current revision. A stale write
  fails with a conflict instead of overwriting another operator.
- Trash is recoverable and deactivates the script in the same guarded write.
  Restore always returns it as an inactive draft. Permanent deletion is
  trash-only.
- Activation remains separately gated by `analytics.toggle`. Script source is
  available only through `GET /admin/analytics/{id}/source`, which requires
  `analytics.edit`; ordinary list viewers receive safe summaries only.
- A second active first-class provider is rejected unless the operator
  explicitly confirms duplicate tracking. Existing intentional duplicates do
  not block an ordinary content edit when provider and activation state stay
  unchanged.
- The list is server-paginated and URL-filtered by search, provider, lifecycle,
  trash, sort, and order. There is no silent 50-row truncation.
- List rows expose name, masked/public identifier, placement, execution mode,
  readiness, revision, and timestamps. They never expose executable config.
- Public analytics configuration and consolidated layout projections include
  only injection facts: `id`, `type`, `config`, `usePartytown`, and `location`.
  Trashed rows are excluded from public injection, provider health, and Meta
  browser/server Pixel parity.

## Provider and runtime rules

- GA4, GTM, Meta Pixel, TikTok Pixel, Cloudflare Web Analytics, and explicit
  custom code remain the supported browser integration types.
- Core validation is activation authority. The React form does not maintain a
  second provider validator that can drift from the server.
- Cloudflare Web Analytics accepts a real site token or official beacon,
  canonicalizes it to the official beacon script, masks the token on list
  surfaces, and always runs on the main thread at the merchant-selected
  placement (body end is the UI default).
- Inactive drafts may contain incomplete GA/GTM/Meta/TikTok snippets so work can
  be saved. Activation rejects placeholders and provider/type mismatches.
- Custom code is explicitly described as trusted administrator code that runs
  on every buyer page while active. It is never presented as a sandbox.
- Provider health remains read-only and cheap. It does not call external
  providers, send test events, or reveal saved source or Meta credentials.
- Meta CAPI keeps its independent fail-closed contract: strict credential reads,
  same-origin browser events, a 15-minute circuit on non-retryable failures, no
  hot retries, and no raw provider/PII logging. This slice did not weaken or
  duplicate that authority.

## Interface decisions

- The page header has one primary action, a reversible trash view, URL-backed
  search/provider/status filters, and a compact provider-readiness rail.
- Provider health is collapsed by default; the summary exposes ready/blocked
  counts without spending a full viewport on six mostly empty cards.
- Integration rows use a dense five-column grammar: integration identity,
  delivery, readiness, update time, and actions. Draft activation is explicit;
  deactivation remains one click.
- At 390 px, the list switches to compact integration cards rather than
  clipping the five-column table. Each card keeps provider/public identifier,
  readiness, visible repair context, placement, execution mode, update time,
  and permission-gated lifecycle actions in one scan. Desktop keeps the dense
  table. Readiness and provider-health states use explicit dark-mode colors.
- Loading uses shape-matched desktop/mobile skeletons. A failed list or health
  read fails closed with a retry state and does not present assumed status.
  Empty accounts offer draft creation; filtered zero-results offer one clear
  filter reset; trash explains recovery and permanent deletion truthfully.
- Create/edit begins with provider choice, then asks for the smallest honest
  input. Cloudflare uses a token field; other first-class providers accept the
  official base snippet; custom code alone is framed as advanced trusted code.
- Placement and worker isolation are progressive disclosure. Activation is a
  separate sidebar decision, with an explicit duplicate-provider acknowledgement.
- Error and empty copy names the repair action. Source-fetch failures stay on
  the route error boundary instead of silently redirecting back to the list.

## Focused verification

- Core analytics validation/service tests cover inactive draft defaults,
  provider validation, Cloudflare canonicalization/masking, safe list summaries,
  duplicate activation, and trash deactivation.
- Admin API tests prove provider health omits credentials/source and paginated
  list responses do not serialize `config` or `<script>`.
- RBAC tests prove source, restore, permanent delete, and toggle use their
  intended permissions.
- Required checks for this slice: analytics/core/API focused Vitest suites,
  admin/API/core/database/api-client typechecks, storefront Astro check,
  package lint, migration metadata check, generated SDK, and a legacy-table
  migration smoke.

## Remaining release proof

- Deploy migration and Workers through the normal release workflow, then test
  create draft, validation failure, activation, duplicate acknowledgement,
  concurrent edit conflict, trash, restore, and permanent delete in production.
- A future structured provider-config model may replace pasted GA/GTM/Meta/
  TikTok base snippets when canonical server generators cover each provider.
  Do not add another client-only generator or preserve two competing sources of
  truth.
- Consent-region controls and provider test-event workflows are separate product
  decisions. Do not fabricate readiness from the presence of an ID or call an
  external provider from list/health reads.

## Live lifecycle checkpoint (2026-07-19)

- Removed the obsolete active `Lorem ipsum` GA4 demo row after the health
  projection correctly diagnosed its invalid snippet. The production account
  now truthfully shows no configured application-managed analytics provider;
  Cloudflare's platform beacon remains independently present on the storefront.
- Trash, restore, and permanent-delete successes now remove the moved row from
  every cached list page immediately, mark other list views stale for their
  next visit, and refresh provider health separately. A success toast can no
  longer coexist with a row that has already changed lifecycle.
- Production restore, trash, and permanent deletion were exercised without a
  page reload at 1440 px. The empty analytics workspace was also checked at a
  real 390 × 844 viewport in dark mode with no horizontal overflow. Admin
  deployment: `4c30182b-13f6-4664-b316-09e22f5980fb`.
