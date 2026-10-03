# Demo-store media upload bridge

This bridge turns the complete staging report of the [asset tools](../assets/README.md) (237 files) into the readiness report that [apply](../apply/README.md) requires. It is for operators of the Scalius demo deployment. It creates and updates Media records through the admin Media API and reads the Media library and the retained products. It has no client that changes a product, category, collection, publication or setting.

Run it from the repository root:

```sh
pnpm exec node scripts/demo-store/media-upload/cli.mjs --upload \
  --manifest /absolute/private/asset-sources.json \
  --staged-report /absolute/private/readiness.json \
  --staged-dir /absolute/private/staged \
  --journal /absolute/private/media-upload.jsonl \
  --output /absolute/private/apply-readiness.json
```

| Option | Default |
| --- | --- |
| `--upload` | Required. Without it the command refuses to write. |
| `--manifest <path>` | `scripts/demo-store/assets/asset-sources.json` |
| `--staged-report <path>` | `.wrangler/demo-store-assets/readiness.json` |
| `--staged-dir <path>` | `.wrangler/demo-store-assets/staged` |
| `--journal <path>` | `.wrangler/demo-store-assets/media-upload.jsonl` |
| `--output <path>` | `.wrangler/demo-store-assets/apply-readiness.json` |
| `--admin-url <origin>` | `https://dashboard.scalius.com` |
| `--timeout-ms <ms>` | 30000 (1000 to 120000) |

The command prompts for the admin email and a hidden password. It rejects credential, cookie, token, and secret arguments and reads no credential from the environment. It signs in at `/api/auth/sign-in/email` and signs out at the end. The journal and the report use private file modes. The run prints a JSON summary (`total`, `uploaded`, `reused`, `adopted`, `posterLinks`). Media API requests are at least 250 ms apart.

## Fail-closed inputs

- The source manifest must hold exactly the 237 approved records of the catalog.
- The staging report must be `ready: true` with `mode: "stage"`, hold the same logical keys, and mark every item `staged`.
- The bridge rechecks each staged filename, source and output SHA-256, size, MIME type, profile, and dimension before it signs in or writes.
- Images must be normalized WebP. Videos keep their verified MP4 or WebM bytes.
- Uploads run one file and one part at a time, with parts of at most 5 MiB and at most 20 parts per file.

## Retained Media

Rider and Halo must account for every existing ready Media identity, direct and poster. A source record must cover each current ready direct or poster association of a retained product exactly once with `remoteReuse` or `retainedReplacement`. The two exclude each other for a logical key.

- **Reuse.** When the current bytes have approved provenance, set `"remoteReuse": { "productId": "prod_...", "mediaId": "media_exact_current_id" }`. The Media ID must be attached to that retained product in the expected direct or poster role. The bridge streams the current remote file through a bounded SHA-256 check and requires the provenance hash.
- **Replacement.** When the current bytes have no ownership or license evidence, the only automated path is a generated replacement. Register the generated source with `--retained-product-id` and `--replaces-media-id` ([register-generated.mjs](../assets/README.md#register-a-generated-original)), or add `"retainedReplacement": { "productId": ..., "mediaId": ... }` with the exact current IDs. The bridge proves that every old direct and poster Media ID is covered, uploads each replacement in turn and carries the old authority into the report. Apply then removes the old associations with an exact SKU-image acknowledgement and points the same SKUs at the new images through the full option matrix. Only the unapproved asset and its product-media association are retired.

A partial cover, a wrong product, role or kind, an unknown old ID, or an unrelated current association stops the run before the first upload.

## Resume and poster evidence

The server upload session is authoritative. The JSONL journal records, per logical key, the session ID, the acknowledged part numbers, the completed or adopted Media ID, and the poster link, with a run fingerprint, an action, a status, and a timestamp. It holds no hash, credential, or URL, and a journal from another run is rejected. On restart, the bridge reads the session and the ready Media again. It adopts a Media file with the deterministic staged filename only after the remote bytes match the staged output hash.

When all files are ready, the bridge links each video to its explicit poster image with a `PATCH` that carries `expectedVersion`. It reads the whole Media library again and records `posterLogicalKey` and `posterMediaId`.

## The readiness report

The `--output` file has `status: "complete"`, the manifest fingerprint, an `evidence` block (no product or publication mutation, sequential upload order, poster link count) and one entry per asset: media identity and file facts (`mediaId`, `sha256`, `url`, `size`, dimensions), `importAction` (`uploaded`, `adopted`, `resumed` or `retained-reuse`) and, where they apply, `retainedReplacement` and poster fields. The bridge writes it only when the whole run checks out. A hash mismatch, a stale version, retained identity drift or an incomplete poster relation stops the run without a report.
