# Handoff - 2026-07-09

## Current Checkpoint

- Branch: `mono-repo`.
- Goal remains active; do not mark complete.
- Temporary `independent-audit.md` was read, distilled into durable docs, ignored in `.gitignore`, and removed from the workspace.
- Latest API deploy completed: `44789313-980c-464c-a2b8-03663a43135b`.
- Latest Admin deploy from this checkpoint: `fdbc0d26-aa93-4a92-a184-62ed0c989088`.

## What Changed

- Added side-by-side stable TypeScript 7 usage through the `typescript7` npm alias for non-Astro `tsc` checks. The normal `typescript` package remains on TS6 for Astro and TypeScript compiler-API consumers.
- Added admin assistant table-surface support for products: visible row IDs, selected counts, click-confirmed `select_visible_rows`, and `clear_selection`.
- Updated the API admin chat route so table-selection actions are proposed only for explicit non-destructive intents and only from browser-advertised visible row IDs.
- Sanitized admin chat model output so provider tool-call/function-call artifacts never render as merchant-facing assistant text; safe action fallback text is used while preserving click-confirmed actions.
- Updated MCP/agent docs and tracker with the audit-derived next work: dialogs, storefront model chat, browser/release smokes, bounded admin multi-tool runtime, and later Admin MCP modularization.
- Hardened deploy tests for no-store MCP responses.

## Verification Already Run

- `pnpm exec vitest run apps/api/src/routes/admin/ai-chat.test.ts --passWithNoTests` passed: 15 tests.
- `pnpm --filter @scalius/api typecheck` passed on `../../node_modules/typescript7/bin/tsc --noEmit`.
- `pnpm --filter @scalius/api lint` passed.
- `git diff --check` passed before handoff edits.
- `pnpm run deploy:api` passed root typecheck, API dry-run build, dist-secret check, D1 migration check, deploy, live `/health`, and four live `/readyz` samples.
- Live demo-admin chat smoke against `https://api.scalius.com/api/v1/admin/ai/chat` passed for:
  - `select_visible_rows`: `200`, `Cache-Control: no-store`, Cloudflare model `@cf/moonshotai/kimi-k2.7-code`, row IDs returned exactly from visible rows.
  - `clear_selection`: `200`, `Cache-Control: no-store`, same model, safe fallback message, no raw tool-call artifacts.
- `pnpm ops:check --queues --samples 1 --timeout-ms 30000 --json` passed with request ID `ops-check-20260708t221457256z-da481f61`.
- `pnpm release:check --skip-live --json` failed only on `MCP-026 P1 In Progress`.

## Expected Release-Check Caveat

- `pnpm release:check --skip-live --json` may still fail while `MCP-026` is intentionally `P1 In Progress`.
- That is bookkeeping, not a runtime failure. Keep it open until dialogs, storefront model chat, and browser/release smokes are implemented and verified.
- Ops warnings remain: ops-monitor email alerts are logs-only/unconfigured/unrestricted, and `worker:testdash` is still an unexpected producer for `payment-events`, `order-notifications`, and `auth-otp`.

## Next Best Work

1. Finish MCP-026 dialog registration for visible confirm/cancel flows. Keep state-changing confirmations browser-owned and click-confirmed.
2. Implement model-backed `storefrontChat` using only public Storefront MCP catalog/discovery/cart-validation tools. Refuse checkout, account, order, payment, recovery, admin, API, off-origin, traversal, and token-like targets.
3. Add release/browser smokes proving admin table actions are visible-only, dialogs are visible-only, and storefront navigation is click-confirmed.
4. After those blockers, build a bounded admin multi-tool chat runtime with capped tool rounds/tokens and an intent-selected read-tool set.
5. Split the large Admin MCP tool registration/projector module into focused modules or a typed factory without changing tool contracts.

## Watchouts

- Do not expose visible row IDs in model prompt text; the API can read them from sanitized `pageContext` only when building a returned action.
- Do not let models choose arbitrary URLs, auto-navigate, or mutate commerce/admin state.
- Admin MCP stays dashboard-proxied and internal-only.
- Storefront MCP/UCP stay catalog-only until a D1-backed signed commerce session design exists.
- Keep `apps/admin-v2/src/routeTree.gen.ts` and `packages/api-client/src/generated/**` generated-only.
