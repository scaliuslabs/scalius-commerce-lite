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

## Rights policy

- Accepted public-source policies are CC0 1.0, Public Domain Mark 1.0, CC BY
  4.0, and the Pexels license. Merchant-owned and original generated work have
  explicit local provenance types.
- CC BY requires saved attribution. CC BY-SA is rejected unless a later policy
  deliberately implements derivative/share-alike compliance.
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
| Product primary, variant, poster | 1600×1600 WebP | sRGB; source is contained in a centered 80% safe-area canvas |
| Product detail/lifestyle | 1600×1600 WebP | sRGB cover using the reviewed crop position |
| Category | 1600×1000 WebP | sRGB cover |
| Desktop hero | 2400×900 WebP | sRGB cover; source must already respect its copy-safe composition |
| Mobile hero | 1080×1350 WebP | sRGB cover; separately composed source, never a blind desktop crop |
| Video | Original MP4/WebM | SHA/MIME/size/dimensions verified; copied without transcoding |

Images use the storefront workspace's pinned `sharp` dependency. Videos require
`ffprobe` so dimensions are verified instead of trusted from the manifest.
Sources are limited to the platform policy (20 MiB images, 100 MiB videos).
Normalized images are rechecked as exact-size WebP files below 20 MiB.

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
`generation.model`; this milestone does not generate any assets.

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
