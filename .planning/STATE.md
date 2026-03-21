# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-22)

**Core value:** BD merchants can manage their entire e-commerce operation from a single platform optimized for the BD market
**Current focus:** Phase 1 — Bengali FTS5 Search

## Current Position

Phase: 1 of 4 (Bengali FTS5 Search)
Plan: 0 of 0 in current phase
Status: Ready to plan
Last activity: 2026-03-22 — Roadmap created with 4 phases, 28 requirements mapped

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**
- Total plans completed: 0
- Average duration: --
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**
- Last 5 plans: --
- Trend: --

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Roadmap]: Bengali FTS5 first (highest risk, shortest implementation, reveals D1 blocker earliest)
- [Roadmap]: BIZ-* grouped with Invoice (Phase 4) since invoices are the primary consumer; SEO-05 Organization JSON-LD gracefully degrades if no business settings exist yet
- [Roadmap]: All 4 phases are technically independent; 1+2 concurrent, 3+4 concurrent

### Pending Todos

None yet.

### Blockers/Concerns

- D1 unicode61 `categories` option unconfirmed — must validate locally before deploy (Phase 1)
- BDBulkSMS and Gennet IP whitelisting may conflict with Workers dynamic IPs (Phase 3)
- `orders.totalAmount` semantics inconsistent in codebase — must verify before invoice template (Phase 4)

## Session Continuity

Last session: 2026-03-22
Stopped at: Roadmap created, ready to plan Phase 1
Resume file: None
