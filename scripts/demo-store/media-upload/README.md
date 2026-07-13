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
