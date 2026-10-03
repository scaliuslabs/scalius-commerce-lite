# Demo-store asset staging

This directory prepares the 237 demo-store media assets for contributors who source, review and stage them. Four tools live here:

- `cli.mjs` stages assets. It is offline and fail-closed: it does not download, generate images, sign in or call an API.
- `register-generated.mjs` records generated originals from local files, with no network request.
- `commons/cli.mjs` and `openverse/cli.mjs` search public APIs for candidate metadata. They never download image bytes.

The output of `cli.mjs --stage` feeds the [media upload bridge](../media-upload/README.md).

## Workflow

1. Pick one source by hand and verify its original rights page. Download the file into a local source directory. Never hotlink it at runtime.
2. Add an `approved` record to the source manifest (`asset-sources.json`). SHA-256, MIME type, byte size, dimensions, creator, license, dates and every visual-rights flag must match before the file can stage.
3. Run a readiness pass: `node scripts/demo-store/assets/cli.mjs --report-only --source-dir /absolute/private/source-directory`
4. When the report is clean, normalize the files: `node scripts/demo-store/assets/cli.mjs --stage --source-dir /absolute/private/source-directory`

| Option | Default |
| --- | --- |
| `--manifest <path>` | `scripts/demo-store/assets/asset-sources.json` (checked in, with no records) |
| `--source-dir <path>` | `scripts/demo-store/assets/source` (not checked in) |
| `--output-dir <path>` | `.wrangler/demo-store-assets/staged` |
| `--report <path>` | `.wrangler/demo-store-assets/readiness.json` |

`--report-only` is the default mode. The output and the report are private artifacts under `.wrangler/` (git-ignored). The CLI exits with status 2 when the run is not ready and 1 on an error. A staged filename depends on the logical key, the profile and the source SHA-256, so new source bytes never reuse a filename.

Each report asset has one status: `missing-source-record`, `invalid-provenance`, `source-invalid`, `ready-to-stage` or `staged`. A product, category or hero counts as ready only when all its logical slots are ready. `progress.remainingByOwner` lists the missing keys of each unready owner.

## Rights policy

- Each source kind accepts only its licenses:

  | Source kind | License code |
  | --- | --- |
  | `merchant-owned` | `Proprietary-Merchant-Owned` |
  | `pexels` | `Pexels` |
  | `wikimedia-commons`, `openverse-verified` | `CC0-1.0`, `PDM-1.0`, `CC-BY-4.0` |
  | `generated-original` | `Generated-Original` |

- CC BY needs saved attribution. CC BY-SA is rejected, because the tools implement no share-alike compliance.
- `acquiredAt` and `verifiedAt` must be real `YYYY-MM-DD` dates with `acquiredAt <= verifiedAt <= today`.
- Every record needs a creator and an HTTPS license URL. A Commons, Openverse or Pexels record also needs HTTPS `sourcePageUrl` and `originalFileUrl`. For Commons, review the license of the individual file page: search metadata is not approval.
- A merchant-owned record needs `merchantOwnershipReference`. A generated record needs `generation.prompt` and `generation.model`.
- A watermark, visible brand, trademarked character, identifiable endorser or unverified option appearance fails the record. Each review flag must be an explicit `true`: a missing flag is not consent.

## Output profiles

| Profile | Master | Behavior |
| --- | --- | --- |
| Product primary, variant, poster | 1600×1600 WebP | sRGB. Trims near-white exterior margins, then fits the image in a centered 80% safe area. |
| Product detail, lifestyle | 1600×1600 WebP | sRGB cover at the reviewed crop position. |
| Category | 1600×1000 WebP | sRGB cover. |
| Desktop hero | 2400×900 WebP | sRGB cover. The source must already respect its copy-safe composition. |
| Mobile hero | 1080×1350 WebP | sRGB cover. Compose it separately; never crop the desktop image. |
| Video | Original MP4 or WebM | The tool verifies SHA, MIME, size and dimensions, and copies the file without transcoding. |

Images use the `sharp` version pinned in the storefront workspace. Videos need `ffprobe`, which verifies dimensions instead of trusting the manifest. Sources follow the platform media policy: 20 MiB for images and 100 MiB for videos. The tool rechecks each normalized image as an exact-size WebP file below 20 MiB.

The trim removes only exterior pixels within 6 levels of pure white, before the resize. It does not detect subjects, replace backgrounds, trim colored scenes or run for cover profiles. Product edges and shadows must differ visibly from near-white exterior space.

## Source record shape

```json
{
  "logicalKey": "vale-everyday-runners:primary",
  "status": "approved",
  "sourceKind": "merchant-owned",
  "sourceFile": "footwear/vale-primary.png",
  "merchantOwnershipReference": "signed release or internal shoot reference",
  "creator": "creator name",
  "license": { "code": "Proprietary-Merchant-Owned", "url": "https://owned.example/rights", "attribution": "" },
  "acquiredAt": "2026-07-13",
  "verifiedAt": "2026-07-13",
  "sha256": "64 lowercase hexadecimal characters",
  "original": { "mime": "image/png", "bytes": 123456, "width": 2000, "height": 2000 },
  "cropPosition": "centre",
  "rightsReview": {
    "reviewedBy": "reviewer identity",
    "noWatermark": true,
    "noVisibleBranding": true,
    "noTrademarkedCharacter": true,
    "noIdentifiableEndorser": true,
    "optionAppearanceVerified": true
  }
}
```

`sourceFile` is relative to `--source-dir` and cannot leave it. `cropPosition` is a `sharp` position such as `centre`, `north`, `entropy` or `attention`. A record for retained-product media can also carry `remoteReuse` or `retainedReplacement` (defined in the [media upload bridge](../media-upload/README.md)).

## Register a generated original

`register-generated.mjs` inspects one local image or video, computes its SHA-256, MIME type, size and dimensions, and upserts one or more exact logical keys into a private manifest. The source file and the manifest must be private: a path outside the repository is accepted, and a path inside it must be under `.wrangler/`. The tool refuses the checked-in `asset-sources.json`, and `--manifest` has no default.

```sh
node scripts/demo-store/assets/register-generated.mjs \
  --manifest .wrangler/demo-store-assets/generated-sources.json \
  --source-dir .wrangler/demo-store-assets/source \
  --file .wrangler/demo-store-assets/source/vale-chalk.png \
  --logical-key vale-everyday-runners:variant-chalk \
  --prompt-file .wrangler/demo-store-assets/prompts/vale-chalk.txt \
  --model gpt-image-2 --creator "Scalius demo studio" \
  --rights-url https://www.scalius.com/asset-rights --reviewed-by demo-reviewer \
  --acquired-at 2026-07-13 --verified-at 2026-07-13 \
  --confirm-no-watermark --confirm-no-visible-branding \
  --confirm-no-trademarked-character --confirm-no-identifiable-endorser \
  --confirm-option-appearance
```

- Use `--prompt <text>` or `--prompt-file <file>`, not both. `--crop-position <position>` changes the default `centre`.
- Repeat `--logical-key` only when one source truthfully serves every named slot after its profile transformation. The tool checks that each key exists and that its kind (image or video) matches. A person decides visual suitability. One source normally must not back both a primary and a variant entry, or both a detail and a lifestyle entry, because the buyer would see duplicate media.
- To replace the media of a retained product, add `--retained-product-id <id> --replaces-media-id <current media id>` with exactly one `--logical-key`. The tool writes `retainedReplacement` on the record.

Pass the private manifest to the readiness pass and to staging with `--manifest .wrangler/demo-store-assets/generated-sources.json --source-dir .wrangler/demo-store-assets/source`.

## Candidate discovery

The discovery tools build a manual-review queue. Their output never approves an asset: every candidate has `approval.eligible: false`. A record becomes `approved` only in a source manifest, after you download the file and compute its SHA-256. A Commons SHA-1 is provenance evidence, not the staging hash.

```sh
node scripts/demo-store/assets/commons/cli.mjs --plan /absolute/path/to/commons-queries.json
node scripts/demo-store/assets/openverse/cli.mjs --plan /absolute/path/to/openverse-queries.json
```

A plan is `{ "schemaVersion": 1, "queries": [{ "logicalKey": "category:home-living:image", "query": "...", "limit": 5 }] }`. It has 1 to 10 queries with unique logical keys. `limit` is 1 to 8 (default 5). A query is one line of at most 120 characters for Commons and 200 for Openverse. The checked-in `queries.json` files hold no queries, so pass `--plan <path>`. `--output <path>` overrides the output file (`.wrangler/demo-store-assets/commons-review.json` or `openverse-review.json`).

- Each tool sends an identifying `User-Agent`, waits one second between queries, times out after 15 seconds, rejects a response over 1 MB and retries once on a throttle or transient error. It reads only page 1 and never requests thumbnails or original bytes.
- Commons uses the Action API. It rejects CC BY-SA, GFDL, unknown licenses and unsupported MIME types.
- Openverse uses the anonymous image API with commercial-use license filters. Search filters are not rights authority: the tool also rejects CC BY versions other than 4.0, unexpected licenses, unsupported extensions, mature results, missing creators or dimensions and missing HTTPS URLs.
- A candidate is `manual-review-required` or `rejected`. A person checks the file or landing page, the exact license, and the full-resolution image (watermarks, brands, trademarks, endorsers, option accuracy), and, for Openverse, that the original URL still works. `applyCommonsManualReview()` and `applyOpenverseManualReview()` turn an explicit failed flag into a rejection reason. An all-pass review gives `manual-review-complete`, never `approved`.
