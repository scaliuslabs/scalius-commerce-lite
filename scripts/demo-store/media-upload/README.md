# Demo-store Media upload bridge

This boundary converts a **complete** 237-file offline staging report into the
post-upload readiness contract consumed by the demo-store apply engine. It can
create and update Media records only. It has no product, category, collection,
publication, or settings mutation client.

Run from the repository root:

```bash
pnpm exec node scripts/demo-store/media-upload/cli.mjs --upload \
  --manifest /absolute/private/asset-sources.json \
  --staged-report /absolute/private/readiness.json \
  --staged-dir /absolute/private/staged \
  --journal /absolute/private/media-upload.jsonl \
  --output /absolute/private/apply-readiness.json
```

Email and password are prompted interactively; password input is hidden. The
CLI rejects credential, cookie, token, and secret arguments and does not read
them from environment variables. Its JSONL journal and final report use private
file modes and contain only logical keys, upload session/resource identities,
part numbers, hashes, dimensions, and safe status evidence.

## Fail-closed inputs

- The source manifest must contain exactly the catalog's 237 approved records.
- The stage-mode report must be `ready: true`, contain the same exact logical
  keys, and every item must be `staged`.
- Every staged filename, source/output SHA-256, byte size, MIME, profile, and
  dimension is rechecked before authentication or Media writes.
- Images must be normalized WebP; videos retain their verified MP4/WebM bytes.
- Uploads run one file and one 5 MiB-or-smaller part at a time.

## Retained Media

Rider and Halo must reuse existing ready Media identities rather than uploading
replacement IDs. Put an explicit mapping on the corresponding source record:

```json
{
  "logicalKey": "rider-court-trainers:primary",
  "remoteReuse": {
    "productId": "prod_9XNNERD2XpAOIoI1SN6gx",
    "mediaId": "media_exact_current_id"
  }
}
```

The bridge requires the Media ID to be attached to that exact retained product
in the expected direct/poster role, streams the current remote object through a
bounded SHA-256 verifier, and requires it to equal the source provenance hash.
Every current ready direct association on a retained product must have exactly
one explicit reuse mapping.

When current bytes do not have defensible ownership/license evidence, generated
original replacements are the only automated path. Register the generated
source normally and add `retainedReplacement` with the exact current product and
Media IDs instead of `remoteReuse`. The bridge proves that every old direct and
poster Media ID is covered, uploads the replacement sequentially, and carries
the old authority into the readiness report. The product apply then removes the
old associations with an exact SKU-image acknowledgement and rebinds the same
SKUs through the full option matrix. Product IDs, SKU IDs, option/value IDs,
stock, reservations, ledger history, and buyer-facing exact-image semantics are
preserved; only the unapproved asset and product-media association identity are
retired.

```json
{
  "logicalKey": "rider-court-trainers:primary",
  "retainedReplacement": {
    "productId": "prod_9XNNERD2XpAOIoI1SN6gx",
    "mediaId": "media_exact_current_id"
  }
}
```

Reuse and replacement are mutually exclusive for a logical key. Partial
coverage, a wrong product/role/kind, an unknown old ID, or an unrelated current
association stops before upload.

## Resume and poster evidence

The server upload session is authoritative. The local JSONL journal records the
session, acknowledged part numbers, completed/adopted Media ID, and poster link.
On restart, the bridge re-reads the session and current ready Media before doing
more work. A deterministic filename match is adopted only after remote bytes
match the staged output hash.

After all files are ready, the bridge CAS-links each video to its explicit
poster image through the Media metadata endpoint, re-reads the complete Media
library, and writes `posterLogicalKey`/`posterMediaId` evidence. Only then can it
emit `status: "complete"` apply readiness. Partial local staging, missing remote
Media, ambiguous filenames, retained identity drift, hash mismatch, stale CAS,
or an incomplete poster relationship stops without producing final readiness.

## Read-only retained Media export

The retained export is a separate recovery boundary for the eight current Rider
and Halo source objects. It never calls a Media, product, or publication write
route. Supply a reviewed authority file containing exactly these logical keys
and their current Media IDs; fixed retained product IDs come from checked-in
code:

- `rider-court-trainers:primary`, `:variant-sand`, `:detail`, `:lifestyle`
- `halo-arc-table-lamp:primary`, `:video`, `:poster`, `:detail`

The private authority JSON supplies one exact HTTPS Media/CDN origin plus only
`logicalKey` and `mediaId` for each entry. Retained product IDs stay fixed in
checked-in code and cannot be overridden by the authority file.

The command rejects incomplete authority files. Run it only into an explicit
private workspace `.wrangler` child directory:

```sh
pnpm exec node scripts/demo-store/media-upload/retained-export-cli.mjs \
  --export-retained \
  --authority .wrangler/demo-store-assets/retained-media-authority.json \
  --source-dir .wrangler/demo-store-assets/retained-sources
```

Authentication uses the upload bridge's interactive prompt: email is entered
normally and password input is hidden. Downloads are sequential and
credential-free. Redirects are inspected
manually and an off-origin redirect is never followed. Every response must have
the exact current Content-Length and MIME; the downloaded file is independently
inspected for MIME, dimensions, byte count, and SHA-256. A second fresh admin
snapshot must match the first before the command creates
`provenance-candidate.json` with mode `0600`.

Generated records deliberately use `status: "unapproved"` and
`sourceKind: "merchant-owned"`. Ownership reference, reviewer identity, rights
checks, creator, license URL, and verification date remain unset, so staging
cannot approve them until a human supplies and reviews that evidence. Halo video
evidence records its exact current poster logical key and Media ID in both
directions.
