# Demo store asset staging

This is an offline, fail-closed boundary between source acquisition and the
demo-store Media importer. It does not download assets, generate images, log in,
or call an API.

## Workflow

1. Curate one source manually and verify its original rights page. Download the
   file into a local source directory; never hotlink it at runtime.
2. Add an `approved` record to `asset-sources.json`. SHA-256, MIME, byte size,
   intrinsic dimensions, creator, license, acquisition/verification dates, and
   every visual-rights review flag must match before the file can stage.
3. Run a readiness pass:

   ```sh
   node scripts/demo-store/assets/cli.mjs --report-only \
     --source-dir /absolute/private/source-directory
   ```

4. After the report is clean, normalize sequentially:

   ```sh
   node scripts/demo-store/assets/cli.mjs --stage \
     --source-dir /absolute/private/source-directory
   ```

The default output and report are private local artifacts under
`.wrangler/demo-store-assets/`. A non-ready run exits with status 2. Staged
filenames are deterministic from logical key, target profile, and source
SHA-256. Replacing source bytes cannot silently reuse a filename.

Every readiness report includes exact asset progress plus complete-owner
progress for all 50 products, five category images, and three two-source hero
stories. A product or hero counts as ready only when every one of its logical
slots is ready; `remainingByOwner` retains the exact missing logical keys so a
partial product cannot be mistaken for an uploadable one.

## Rights policy

- Accepted public-source policies are CC0 1.0, Public Domain Mark 1.0, CC BY
  4.0, and the Pexels license. Merchant-owned and original generated work have
  explicit local provenance types. Source kind and license are paired
  semantically: merchant-owned uses `Proprietary-Merchant-Owned`, Pexels uses
  `Pexels`, Commons/Openverse may use only CC0/PDM/CC BY 4.0, and generated
  originals use `Generated-Original`.
- CC BY requires saved attribution. CC BY-SA is rejected unless a later policy
  deliberately implements derivative/share-alike compliance.
- Acquisition and verification values must be real `YYYY-MM-DD` calendar
  dates, ordered `acquiredAt <= verifiedAt <= today`. Date-shaped values such
  as `2026-02-30`, reversed reviews, and future verification are rejected.
- Wikimedia Commons records must identify the individual file page and original
  download URL. Per-file license/extmetadata must be reviewed; search metadata
  alone is not approval. A later downloader should query only a few candidates
  with `generator=search`, `filetype:bitmap`, and `imageinfo` URL/size/MIME/SHA1/
  filtered extmetadata, then download rather than hotlink. This command performs
  no such network work.
- Pexels records retain the source page, photographer, license URL, and download
  date even when attribution is optional.
- Watermarks, visible brands, trademarked characters, identifiable endorsers,
  and unverified option appearance fail the record. Boolean review flags are
  intentionally explicit; omitting one is not treated as consent.

## Output profiles

| Profile | Master | Behavior |
| --- | --- | --- |
| Product primary, variant, poster | 1600×1600 WebP | sRGB; contiguous near-white exterior margins are trimmed, then the source is contained in a centered 80% safe-area canvas |
| Product detail/lifestyle | 1600×1600 WebP | sRGB cover using the reviewed crop position |
| Category | 1600×1000 WebP | sRGB cover |
| Desktop hero | 2400×900 WebP | sRGB cover; source must already respect its copy-safe composition |
| Mobile hero | 1080×1350 WebP | sRGB cover; separately composed source, never a blind desktop crop |
| Video | Original MP4/WebM | SHA/MIME/size/dimensions verified; copied without transcoding |

Images use the storefront workspace's pinned `sharp` dependency. Videos require
`ffprobe` so dimensions are verified instead of trusted from the manifest.
Sources are limited to the platform policy (20 MiB images, 100 MiB videos).
Normalized images are rechecked as exact-size WebP files below 20 MiB.

Contain-safe trimming is deliberately conservative: it removes only exterior
pixels within a six-level tolerance of pure white before resizing. It does not
detect subjects, replace backgrounds, trim opaque colored scenes, or run for
detail/lifestyle cover profiles. Product edges and shadows must remain visibly
different from near-white exterior space; ambiguous all-white inputs are left
unchanged by the image pipeline.

## Source record shape

```json
{
  "logicalKey": "vale-everyday-runners:primary",
  "status": "approved",
  "sourceKind": "merchant-owned",
  "sourceFile": "footwear/vale-primary.png",
  "merchantOwnershipReference": "signed release or internal shoot reference",
  "creator": "creator name",
  "license": {
    "code": "Proprietary-Merchant-Owned",
    "url": "https://owned.example/rights",
    "attribution": ""
  },
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

Public-source records additionally require HTTPS `sourcePageUrl` and
`originalFileUrl`. Generated-original records require `generation.prompt` and
`generation.model`; this tooling does not generate any assets.

## Register a generated original privately

`register-generated.mjs` inspects one already-generated local image or video,
computes its SHA-256, MIME, bytes, and intrinsic dimensions, and atomically
upserts one or more exact demo-manifest logical keys. It performs no network
request, model call, Media upload, or other API write.

Both the source and manifest must be private. Paths outside the repository are
accepted; paths inside the repository must be under the Git-ignored
`.wrangler/` tree. The checked-in `asset-sources.json` and every other
repository path are refused, and `--manifest` has no default.

```sh
node scripts/demo-store/assets/register-generated.mjs \
  --manifest .wrangler/demo-store-assets/generated-sources.json \
  --source-dir .wrangler/demo-store-assets/source \
  --file .wrangler/demo-store-assets/source/vale-chalk.png \
  --logical-key vale-everyday-runners:variant-chalk \
  --prompt-file .wrangler/demo-store-assets/prompts/vale-chalk.txt \
  --model gpt-image-2 \
  --creator "Scalius demo studio" \
  --rights-url https://www.scalius.com/asset-rights \
  --reviewed-by demo-reviewer \
  --acquired-at 2026-07-13 \
  --verified-at 2026-07-13 \
  --confirm-no-watermark \
  --confirm-no-visible-branding \
  --confirm-no-trademarked-character \
  --confirm-no-identifiable-endorser \
  --confirm-option-appearance
```

Repeat `--logical-key` only when the same source truthfully serves every named
slot after its profile transformation. The helper verifies key existence and
image/video kind, but visual suitability remains a human review decision. A
single source normally must not back primary and variant gallery entries, or
detail and lifestyle entries, because that creates duplicate or misleading
buyer media.

Use the resulting private manifest explicitly for readiness and staging:

```sh
node scripts/demo-store/assets/cli.mjs --report-only \
  --manifest .wrangler/demo-store-assets/generated-sources.json \
  --source-dir .wrangler/demo-store-assets/source
```

## Wikimedia Commons candidate discovery

`commons/cli.mjs` is a read-only research helper, not a downloader or approval
tool. Put at most ten targeted searches in a private or reviewed plan:

```json
{
  "schemaVersion": 1,
  "queries": [
    {
      "logicalKey": "category:home-living:image",
      "query": "calm neutral home interior objects no people",
      "limit": 5
    }
  ]
}
```

Then create a private review queue:

```sh
node scripts/demo-store/assets/commons/cli.mjs \
  --plan /absolute/path/to/commons-queries.json
```

The tool issues sequential, identified requests to the Commons Action API with
`generator=search`, namespace 6, `filetype:bitmap`, `maxlag=5`, and no more than
eight candidates per query. It requests one current `imageinfo` record with
URL, description page, size, MIME, SHA-1, and only the creator/license/
attribution/description extended-metadata fields needed for review. Extended
metadata is expensive, so continuation is deliberately ignored and requests
are separated by one second. HTTP 429/503 receives one bounded retry only.

The output under `.wrangler/demo-store-assets/commons-review.json` is always a
manual-review queue:

- CC0, Public Domain Mark, and CC BY 4.0 candidates may enter manual review;
- CC BY-SA, GFDL, unknown licenses, PDFs, and unsupported image MIME types are
  rejected automatically;
- watermark, visible-brand, trademarked-character, identifiable-endorser,
  option-appearance, and source-page-license checks remain explicit `null`
  fields until a person reviews the original file page and full-resolution
  image. `applyCommonsManualReview()` converts any explicit failed flag into a
  rejection reason; even an all-pass review becomes `manual-review-complete`,
  never approved;
- every candidate has `approval.eligible: false`. Discovery output cannot be
  passed to staging as an approved record;
- the original image URL is preserved for later manual download, but this tool
  never fetches it. A later approved staging record must compute SHA-256 from
  downloaded bytes; Commons SHA-1 is provenance evidence, not the staging hash.

This follows the official [Imageinfo API](https://www.mediawiki.org/wiki/API:Imageinfo)
warning to request expensive extended metadata for only a few results and the
Commons requirement for an identifiable User-Agent and considerate request
rates.

## Openverse candidate discovery

`openverse/cli.mjs` is the parallel metadata-only research path for Openverse's
official anonymous image API. Its plan has the same shape and ten-query/eight-
result limits as the Commons plan. It always requests page 1 with:

- `mature=false` and `filter_dead=true`;
- `extension=jpg,jpeg,png,webp`;
- `license=cc0,pdm,by`;
- `license_type=commercial,modification`.

```sh
node scripts/demo-store/assets/openverse/cli.mjs \
  --plan /absolute/path/to/openverse-queries.json
```

The private `.wrangler/demo-store-assets/openverse-review.json` queue preserves
`foreign_landing_url`, original URL, creator/creator URL, Openverse attribution,
license code/version/URL, provider, source, file type/size, and dimensions. The
client identifies itself, waits one second between queries, has a 15-second
timeout and 1 MB response ceiling, and performs only one bounded retry for 429
or transient 5xx responses. It never requests thumbnails, original image bytes,
related results, or later pages.

Search filters are not rights authority. Returned CC BY versions other than 4.0,
unexpected licenses, unsupported extensions, mature results, missing creators,
or missing HTTPS landing/original URLs are rejected locally. Every otherwise
eligible record still starts at `manual-review-required`; the reviewer must
open the foreign landing page, verify its exact license, inspect the original
for watermarks/brands/trademarks/identifiable endorsers and option accuracy,
and confirm the original URL remains reachable. Failed flags reject the
candidate. All-pass review remains `manual-review-complete` with
`approval.eligible: false`; only a separate downloaded-byte SHA-256 staging
record can later become approved.

The request and response fields follow the official
[Openverse image API](https://api.openverse.org/), which explicitly describes
anonymous access, pagination limits, search filters, and image provenance
fields.
