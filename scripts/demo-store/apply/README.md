# Demo-store lifecycle apply

This directory holds the authenticated, fail-closed lifecycle behind `pnpm demo:store --apply`. It is for operators of the Scalius demo deployment. Apply is an interactive command, never CI automation. Plan, compile and diff stay read-only. [compile-contract.md](../compile-contract.md) describes the command intents that apply runs.

## Phase contract

`phase-model.mjs` fixes the phase order. A phase is `ready`, `skipped` or `blocked`. A blocked phase refuses the whole apply before the first write.

1. `quarantine`: deactivates active demo-owned products and active collections, with revision claims.
2. `stage_vocabulary`, `stage_categories`, `stage_products`, `stage_collections`: create the `Brand` attribute when its slug is absent, create or update the categories, save each product (demo-owned ones inactive) with its option matrix or simple SKU, and save each collection inactive.
3. `stage_theme`: saves the homepage as the shared theme draft.
4. `activate_products` (each non-retained product), `publish_categories` (after their products), `activate_collections`.
5. `activate_promotions` and `publish_navigation`: skipped. Each blocks the apply if a publication intent lists promotions, or header or footer.
6. `publish_theme`: publishes exactly the saved draft revision.

- Demo-owned non-retained products are saved inactive and always get an activation command, including products that an interrupted run left inactive. Their offers are product aggregate facts and finish before activation. Retained Rider and Halo keep their lifecycle and operational SKU authority.
- Existing active collections are deactivated with their current revision before their new configuration is saved. They reactivate after the catalog publication phases.
- The homepage is the storefront theme. Each manifest hero becomes a slide of the first hero section: desktop image, mobile image as the phone image, title as alt text and heading, copy as text, destination route as link. `homepageCollections` become the collection IDs of the first collections section. The rest of the published theme carries over (`../theme-homepage.mjs`).
- A saved draft is not public, so staging needs no quarantine. The draft is saved at the workspace revisions the snapshot read. Publication publishes exactly that draft revision and runs last, because every slide destination and homepage collection must already resolve publicly.
- A draft with any other unpublished change, a draft not based on the live revision, or a theme without a hero section and a collections section blocks the apply. A draft that differs only in the demo slides and collections (an interrupted run) is adopted.
- An existing `Brand` attribute that is not filterable or has another name stops the run. Apply never overwrites it, because the attribute update API has no revision claim.
- The CLI never writes header, footer or standalone promotions. It passes an empty publication intent, and the code refuses an intent that names them. Add such writes only with a revision claim on every write.

## Authorization and resume

The intent fingerprint is the SHA-256 of the validated manifest plus the publication intent, in canonical JSON with sorted keys. Prices, descriptions, offers, collections, heroes and homepage collections cannot change after the operator confirms.

A resume record (`schemaVersion: 2`, `resume-journal.mjs`) holds the intent fingerprint, phase, logical key, status (`applied`, `already_applied` or `adopted_after_ambiguous_response`) and a safe `authority` (resource id and monotonic revision). Restoration rejects another fingerprint, a changed resource identity, a revision that moves backwards, malformed JSON and an unknown field.

The executor (`apply-executor.mjs`) reads the current resource first and returns `already_applied` when it matches. It stops on a `conflict` (identity exists, resource missing, stale revision or HTTP 409). After each write it reads the resource again and fails if it does not match. The orchestrator skips a staging command only when its activation or publication command is already in the journal. The journal restores references and never replaces verification.

## Admin permissions

The preflight (`preflight.mjs`) derives the required permissions from the planned commands: `attributes.create`, `categories.create`, `categories.edit`, `products.create`, `products.edit`, `collections.create`, `collections.edit` and `settings.general.edit` (theme draft and publish). It reads the account's permissions from `GET /api/v1/admin/rbac/my-permissions`. A super admin passes. A command with no permission rule fails.

## CLI exposure gate

Run from the repository root with the complete report from the [media upload bridge](../media-upload/README.md):

```sh
pnpm demo:store --apply \
  --media-readiness .wrangler/demo-store-assets/apply-readiness.json
```

`--media-readiness` is required. `--resume-file` defaults to `.wrangler/demo-store-apply/resume-<fingerprint>.jsonl` and `--evidence-dir` to `.wrangler/demo-store-apply/evidence`. All three paths must be real, private files or directories below the workspace `.wrangler` directory. The command takes credentials only from the interactive email and hidden password prompts. It validates the readiness report before it signs in. Then it:

1. reads a bounded fresh admin snapshot and proves all 237 readiness records against the current remote Media IDs, metadata, dimensions, URLs, import actions and every video-poster relation;
2. builds a fresh diff and lifecycle, rejects identity conflicts and derives the required permissions from every planned write;
3. prints the full SHA-256 intent fingerprint and requires both the exact phrase `RESET SCALIUS MARKET DEMO` and the full fingerprint;
4. reads the snapshot and the permissions again, and aborts if the authority changed during the confirmation;
5. runs the compiler intents through the binder, the idempotent executor and the lifecycle, and records only safe revision and identity evidence in the resume journal; and
6. reads the store again and verifies every terminal command and the final desired-state diff before it reports success.

Evidence goes to `run-<timestamp>-<id>/` under the evidence directory, with the diff files and `apply-result.json`. No credential, session cookie, request payload or buyer data enters the resume or evidence files. Resources outside the manifest are reported and left untouched.
