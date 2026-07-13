# Demo-store lifecycle apply

This directory owns the write-disabled lifecycle architecture that sits between
the pure demo command compiler and a future authenticated CLI executor. The
public `pnpm demo:store` command remains plan/diff-only.

## Phase contract

The fixed order is quarantine, create-only vocabulary reconciliation,
category/product/collection/hero staging,
product activation, category publication, collection activation, promotion
activation, Theme publication, Header/Footer navigation publication, and hero
activation. A phase may be `ready`, `skipped`, or `blocked`; a blocked phase is
never bypassed by the orchestrator.

- Demo-owned non-retained products are staged inactive and always receive an
  activation command, including products found inactive after an interrupted
  earlier run. Retained Rider and Halo preserve their lifecycle and operational
  SKU authority.
- Existing active collections and heroes are revision-deactivated before their
  desired configuration is staged. They reactivate only after catalog
  publication dependencies have completed.
- Product/SKU offers in the manifest are product aggregate facts and finish
  before product activation. Standalone discount-code promotions remain
  blocked because the current discount authority has no monotonic revision.
- Theme may publish only with its saved revision. Header/Footer navigation is
  an explicit blocked phase until each document has a monotonic revision and
  every write requires `expectedRevision`.
- Brand vocabulary is created only when the exact slug is absent. An existing
  non-filterable or renamed Brand is a blocked unversioned conflict, never an
  automatic overwrite.
- Heroes activate last because every category/collection destination must
  already resolve publicly.

## Authorization and resume

Authorization hashes the complete validated manifest plus the complete
publication intent with stable key ordering. Prices, descriptions, offers,
collections, heroes, Theme, and navigation therefore cannot change after the
operator confirms the run.

Resume records use schema version 2 and contain only safe resource identity and
monotonic authority (`aggregateRevision`, `revision`, or `version`). Restoration
rejects another intent fingerprint, changed resource identity, backwards
revisions, malformed JSON, and unknown authority fields. Completed outcomes are
still reconciled by the idempotent executor; the journal restores references,
not permission to skip verification.

## Remaining exposure gate

Do not add `--apply` until remote media upload/readiness, authenticated
write-session wiring, complete desired-state verification, production
permissions preflight, and deployed browser/release smokes all pass. Navigation
and standalone promotions must remain excluded until their APIs gain CAS.
