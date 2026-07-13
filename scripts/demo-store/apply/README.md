# Demo-store lifecycle apply

This directory owns the authenticated, fail-closed lifecycle behind the guarded
`pnpm demo:store --apply` command. Plan, compile, and diff remain read-only.
Apply is an interactive operator command, never unattended CI automation.

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
- The older staged-only executor now refuses any active non-retained product,
  collection, or hero instead of updating a public resource without first
  running this quarantine lifecycle.
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

## CLI exposure gate

Run only from the repository root with the complete private readiness output
created by the remote Media upload bridge:

```sh
pnpm demo:store --apply \
  --media-readiness .wrangler/demo-store-assets/apply-readiness.json
```

Readiness, resume, and evidence paths must be real private files or directories
below the workspace `.wrangler` boundary. Credentials are accepted only from
the interactive email and hidden-password prompts. The command then:

1. authenticates and reads a bounded fresh admin snapshot;
2. proves all 237 readiness records against current remote Media IDs, metadata,
   dimensions, URLs, import actions, and every video-poster relationship;
3. builds a fresh diff and lifecycle, rejects identity conflicts, and derives
   the exact required RBAC permissions from every planned mutation;
4. prints the complete SHA-256 intent fingerprint and requires both the exact
   `RESET SCALIUS MARKET DEMO` phrase and the full fingerprint;
5. reads the snapshot and permissions again, aborting if authority changed
   while the operator confirmed;
6. executes the existing compiler intents through the shared binder,
   idempotent executor, and lifecycle runtime, recording only private safe
   revision/identity resume evidence; and
7. re-reads the store and verifies every terminal command plus the final
   desired-state diff before reporting success.

No credential, session cookie, request payload, or buyer data is written to the
resume/evidence files. Resources outside the manifest are reported and left
untouched for a separate reviewed decision.

Header/Footer navigation and standalone promotion writes remain excluded until
those authorities have monotonic CAS. The checked-in CLI publication intent is
empty, so Theme publication is skipped too. Remote Media staging must reach a
complete upload-bridge report before apply can pass its first authenticated
gate. Do not weaken these exclusions to complete a demo run.
