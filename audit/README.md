# Operations Index

This directory contains current production operations guidance only. Historical audit reports, remediation trackers, rewrite checklists, and superseded goal files were removed because they had become stale and misleading.

- [OPERATIONAL_RUNBOOK.md](OPERATIONAL_RUNBOOK.md) — read-only production checks, incident signals, deployment evidence, and rollback investigation.
- [ops-monitoring-contract.md](ops-monitoring-contract.md) — Cloudflare ops-monitor bindings, queue metrics, alerts, and verification contract.

Treat source code, tests, generated contracts, current Cloudflare state, and fresh command output as authoritative. Do not recreate a long-lived issue ledger in this directory; use the repository issue tracker for open work and keep durable rules beside the owning code or in `AGENTS.md`.
