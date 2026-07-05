# Scalius Commerce

Root agent context is intentionally small. Treat this file as a router, not a codebase tour.

## Load First

- Current remediation queue: `audit/REMEDIATION_TRACKER.md`
- Verification/deploy playbook: `audit/VERIFICATION_PLAYBOOK.md`
- Platform goal and release bar: `docs/codex/PLATFORM-GOAL.md`
- Architecture map when boundaries are unclear: `docs/ARCHITECTURE.md`
- Historical full agent notes only when a missing landmine blocks you: `docs/codex/AGENTS-REFERENCE.md`

## Non-Negotiables

- Use `pnpm` from the repo root. Deploy through `pnpm run deploy*`, not pnpm's package deploy behavior.
- Never hand-edit generated files: `apps/admin-v2/src/routeTree.gen.ts` and `packages/api-client/src/generated/**`.
- After API contract changes, run `pnpm generate:sdk`. After schema changes, run `pnpm db:generate`.
- Do not touch `.dev.vars`, `.env*`, or other secret-bearing files.
- Keep Cloudflare bindings and Worker `Env` declarations synchronized, then run `pnpm check:env`.
- `@scalius/database` and `@scalius/shared` use subpath imports such as `@scalius/database/schema`; avoid root imports.
- Storefront code may import shared/api-client packages, but must not import `@scalius/core` or `@scalius/database` without an explicit architecture decision.

## High-Risk Landmines

- D1 is the authority for auth, setup, checkout, payment, inventory, scanner tokens, and customer sessions. KV/cache rows are hints unless a domain doc proves otherwise.
- Checkout/order/payment writes must be idempotent and commit local state before provider side effects when duplicate orders, stock leaks, or double charges are possible.
- Phone collection is mandatory for customer identity and checkout in Bangladesh. Do not add a merchant setting that disables phone collection.
- Products are merchandising containers. Sellable/inventory identities are `product_variants`; simple products use exactly one hidden/default persisted SKU, never product-level inventory.
- Public checkout/config/payment readiness must fail closed. Do not guess COD or a gateway when settings cannot be read.
- Sensitive forms must be safe before hydration and with JavaScript disabled. Credentials, OTPs, tokens, phone/email, cart, payment, and discount values must not enter URLs.
- Provider failures should log masked metadata only. Never log raw OTPs, credentials, receipt tokens, provider payloads, or buyer PII.

## Work Loop

1. Check `audit/REMEDIATION_TRACKER.md` before choosing or continuing a slice.
2. Load only the task-specific docs and files needed for the slice.
3. Prefer small, boring fixes that remove complexity instead of explaining it away.
4. Add focused tests around the failure mode before broad gates.
5. For meaningful code changes, verify locally, deploy when required, smoke live behavior, update docs, then commit.

## Context Hygiene

Add to this root file only when the fact is non-obvious, repeatedly trips agents, and cannot be enforced in code/tests. Otherwise fix the code, add a test, or put narrow notes in the relevant domain doc.
