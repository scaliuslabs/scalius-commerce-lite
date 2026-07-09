# Codex Working Notes

Last reviewed: 2026-07-10

This folder is for Codex operational context only. Treat source code, tests, deployed behavior, `audit/REMEDIATION_TRACKER.md`, and GitHub issues as the source of truth; older markdown and comments can be stale.

## Files

- `CODEBASE-MAP.md` - implementation-derived architecture map and data-flow notes.
- `PLATFORM-GOAL.md` - product, architecture, and stable-release bar for future agents.
- `AGENT-PLATFORM-ARCHITECTURE.md` - accepted target ADR for the separately deployed Admin and Storefront agent platforms.
- [`audit/AGENT-PLATFORM-REQUIREMENTS.md`](../../audit/AGENT-PLATFORM-REQUIREMENTS.md) - exhaustive target requirement-to-evidence checklist and current readiness state.
- `MCP-AGENT-ARCHITECTURE.md` - durable assistant/MCP architecture, first-release scope, and verification gates.
- `AGENTS-REFERENCE.md` - archived long-form agent context. Use only when the root router and focused docs do not contain the needed landmine.
- `WIDGET-AI.md` - current widget AI provider/prompt architecture and verification targets.
- `WIDGET-SYSTEM.md` - widget/page-builder purpose, quality bar, and reliability requirements.
- `ISSUE-LOG.md` - historical GitHub issue verification log. Use `audit/REMEDIATION_TRACKER.md` for the current remediation queue.

## Toolchain Rules

- TypeScript 7 migration keeps root `typescript` on 6.x for JS compiler API consumers (`typescript-eslint`, Astro/Volar/`@astrojs/check`, `openapi-ts`/`tsx` as needed) and uses the root `typescript7` alias to `npm:typescript@7.0.2` as the stable TS7 compiler path.
- Non-Astro package `typecheck` scripts run `../../node_modules/typescript7/bin/tsc --noEmit`; storefront stays on `astro check` until embedded-language tooling supports TS7 programmatic APIs.
- Do not use `@typescript/native-preview`/`tsgo` for the stable path.

## Rules For Updating

- Update these notes after a meaningful codebase discovery, fix, deploy, or browser verification.
- Mark an issue as verified only after the relevant local or production browser/API flow has settled and been checked.
- Keep notes concise and factual. Link to code paths and commits instead of copying large implementation details.
