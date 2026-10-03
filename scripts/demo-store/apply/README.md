# Demo-store lifecycle apply

This directory holds the authenticated, fail-closed lifecycle behind `pnpm demo:store --apply`. It is for operators of the Scalius demo deployment. Apply is an interactive command, never CI automation. Plan, compile, and diff stay read-only. [compile-contract.md](../compile-contract.md) describes the command intents that apply runs.

## Phase contract

The fixed phase order is in `phase-model.mjs`:

| # | Phase | What it does |
| --- | --- | --- |
| 1 | `quarantine` | Deactivates active demo-owned products and active collections, with revision claims. |
| 2 | `stage_vocabulary` | Creates the `Brand` attribute when its slug is absent. |
| 3 | `stage_categories` | Creates or updates the categories. |
| 4 | `stage_products` | Saves each product (demo-owned ones inactive), then its option matrix or simple SKU. |
| 5 | `stage_collections` | Saves each collection inactive. |
| 6 | `stage_theme` | Saves the homepage as the shared theme draft. |
| 7 | `activate_products` | Activates each non-retained product. |
| 8 | `publish_categories` | Publishes each category after its products. |
| 9 | `activate_collections` | Activates the collections. |
| 10 | `activate_promotions` | Skipped. Blocked if a publication intent lists promotions. |
| 11 | `publish_navigation` | Skipped. Blocked if a publication intent lists header or footer. |
| 12 | `publish_theme` | Publishes exactly the saved draft revision. |

A phase is `ready`, `skipped`, or `blocked`. The orchestrator never bypasses a blocked phase. A blocked phase refuses the whole apply before the first write.

- Demo-owned non-retained products are saved inactive and always get an activation command, including products that an interrupted run left inactive. Their offers are product aggregate facts and finish before activation. Retained Rider and Halo keep their lifecycle and operational SKU authority.
- Existing active collections are deactivated with their current revision before their new configuration is saved. They reactivate after the catalog publication phases.
- The homepage is the storefront theme. Each manifest hero becomes a slide of the first hero section: desktop image, mobile image as the phone image, title as alt text and heading, copy as text, destination route as link. `homepageCollections` become the collection IDs of the first collections section. The rest of the published theme carries over (`../theme-homepage.mjs`).
- A saved draft is not public, so staging needs no quarantine. The draft is saved at the workspace revisions that the snapshot read. Publication publishes exactly that draft revision over the live revision, and it runs last, because every slide destination and homepage collection must already resolve publicly.
- A draft with any other unpublished change, a draft not based on the live revision, or a theme without a hero section and a collections section blocks the apply. A draft that differs only in the demo slides and collections (an interrupted run) is adopted.
- An existing `Brand` attribute that is not filterable or has another name stops the run. Apply never overwrites it, because the attribute update API has no revision claim.
- The CLI never writes header, footer, or standalone promotions. It passes an empty publication intent, and the code refuses an intent that names them. Add such writes only with a revision claim on every write.

## Authorization and resume

The intent fingerprint is the SHA-256 of the validated manifest plus the publication intent, in canonical JSON with sorted keys. Prices, descriptions, offers, collections, heroes, and homepage collections cannot change after the operator confirms.

A resume record has `schemaVersion: 2`, the intent fingerprint, phase, logical key, status (`applied`, `already_applied`, or `adopted_after_ambiguous_response`), timestamp, and a safe `authority`: `id`, `defaultVariantId`, and the monotonic `aggregateRevision`, `revision`, or `version`. Restoration rejects another fingerprint, a changed resource identity, a revision that moves backwards, malformed JSON, and an unknown field.

The executor (`apply-executor.mjs`) reads the current resource first and returns `already_applied` when it matches. It stops on a `conflict` (identity exists, resource missing, stale revision, or HTTP 409). After each write it reads the resource again and fails if it does not match. The orchestrator skips a staging command only when its activation or publication command is already in the journal. The journal restores references; it never replaces verification.

## Admin permissions

Apply writes only through these admin endpoints: attributes (create), categories (create, update, status), products (create, update, option matrix, SKU update), collections (create, update), and the theme (`POST /settings/theme/draft` and `/settings/theme/publish`). The preflight (`preflight.mjs`) derives the required permissions from the planned commands: `attributes.create`, `categories.create`, `categories.edit`, `products.create`, `products.edit`, `collections.create`, `collections.edit`, and `settings.general.edit`. It reads them from `GET /api/v1/admin/rbac/my-permissions`. A super admin passes. A command with no permission rule fails.

## CLI exposure gate

Run from the repository root with the complete report from the [media upload bridge](../media-upload/README.md):

```sh
pnpm demo:store --apply \
  --media-readiness .wrangler/demo-store-assets/apply-readiness.json
```

The readiness, resume, and evidence paths must be real, private files or directories below the workspace `.wrangler` directory. The command takes credentials only from the interactive email and hidden password prompts. It validates the readiness report before it signs in. Then it:

1. reads a bounded fresh admin snapshot;
2. proves all 237 readiness records against the current remote Media IDs, metadata, dimensions, URLs, import actions, and every video-poster relation;
3. builds a fresh diff and lifecycle, rejects identity conflicts, and derives the required permissions from every planned write;
4. prints the full SHA-256 intent fingerprint and requires both the exact phrase `RESET SCALIUS MARKET DEMO` and the full fingerprint;
5. reads the snapshot and the permissions again, and aborts if the authority changed during the confirmation;
6. runs the compiler intents through the binder, the idempotent executor, and the lifecycle, and records only safe revision and identity evidence in the resume journal; and
7. reads the store again and verifies every terminal command and the final desired-state diff before it reports success.

Evidence goes to `run-<timestamp>-<id>/` under the evidence directory, with the diff files and `apply-result.json`. No credential, session cookie, request payload, or buyer data enters the resume or evidence files. Resources outside the manifest are reported and left untouched.
