# Codex Working Notes

Last reviewed: 2026-07-12

This folder contains concise engineering context. Treat source code, tests, deployed behavior, fresh command output, and GitHub issues as the source of truth; older prose can be stale.

## Files

- `PLATFORM-GOAL.md` - product, architecture, and stable-release bar.
- `catalog/README.md` - current catalog hardening audit, evidence, decisions, and implementation order.
- `INVENTORY-ORDERS-COMPETITIVE-AUDIT.md` - verified Shopify, Medusa, and Adobe inventory/order benchmark with prioritized Scalius gaps.

## Toolchain Rules

- TypeScript 7 migration keeps root `typescript` on 6.x for JS compiler API consumers (`typescript-eslint`, Astro/Volar/`@astrojs/check`, `openapi-ts`/`tsx` as needed) and uses the root `typescript7` alias to `npm:typescript@7.0.2` as the stable TS7 compiler path.
- Non-Astro package `typecheck` scripts run `../../node_modules/typescript7/bin/tsc --noEmit`; storefront stays on `astro check` until embedded-language tooling supports TS7 programmatic APIs.
- Do not use `@typescript/native-preview`/`tsgo` for the stable path.

## Rules For Updating

- Update these notes after a meaningful codebase discovery, fix, deploy, or browser verification.
- Mark an issue as verified only after the relevant local or production browser/API flow has settled and been checked.
- Keep notes concise and factual. Link to code paths and commits instead of copying large implementation details.
