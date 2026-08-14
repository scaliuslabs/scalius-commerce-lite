# Catalog and media

## Product creation

Prefer one atomic `dashboard.products.create` after resolving prerequisites:

Fast path: discover the operation IDs once, describe `dashboard.products.create` once with the full schema, resolve category/attribute/media IDs with bounded reads, then submit one product body. Do not search or refetch the contract between every step. After source facts and usable images are available, a normal multi-variant product should take minutes, not a long exploratory session.

1. Find or create the category. A category cannot publish until it has an active product with a buyer-resolvable SKU.
2. Find or create attributes; product assignments use attribute IDs and merchant-visible string values.
3. Commit media first. For public web assets use `dashboard.media.import_url` through either MCP or CLI. If the source rejects server-side import or the file is local, use one guided command for all files: `scalius media upload image-1.jpg image-2.png --yes`. It validates type/size and performs initiate → parts → complete internally; do not manually run those three operations unless resuming or debugging a session.
4. Build product-media associations. A `media_*` identifies the committed asset; a caller-local `pmed_*` identifies its association within the product. Variant `imageId` points to `pmed_*`, not `media_*`.
5. For an option matrix, define option axes in merchant order, give every value a request-local ID, and give each variant one selected value ID per axis in that same order. Request-local option/value/variant IDs correlate only this atomic request.
6. Include long description, additional information, attributes, media, variants, SEO, visibility, price, stock, and tracking in the same create call.
7. Verify `base`, `media`, `attributes`, `additional_info`, `options`, and paged `variants` through bounded product sections, batching independent reads when available. Confirm every variant-specific `imageId` resolves to the intended product-media association. Then publish the category if requested.

For a retailer/source URL, extract facts and image URLs without copying unsupported claims. Prefer original supported assets; attempt URL import first. If download is necessary, validate the signature locally and upload the files together. Preserve request IDs and inspect the session before retrying a call whose output was lost so an agent does not create orphan uploads or duplicate products.

Do not call per-variant creation after an atomic matrix create. Do not use product-level inventory for optioned products. SKU and barcode identities are globally normalized and must be unique.

## Media policy

Remote MCP servers cannot read a client's local filesystem, and MCP tool arguments do not define a portable file-upload primitive. This is a host boundary, not a hidden CLI requirement: shell-less agents can import credential-free public HTTPS assets with `dashboard.media.import_url`; local-only files require a client capable of the reviewed direct-upload action. Never embed multi-megabyte base64 media in model context.

Accepted images are JPEG (`.jpg`/`.jpeg`), PNG, GIF, WebP, and AVIF, at most 20 MiB each. Accepted video is MP4 and WebM, at most 100 MiB. Extension, declared MIME type, and file signature must agree. One raw part is at most 5 MiB; use the session's exact part size/count.

Retain an already-supported image when it is within limits. Do not recompress JPEG merely to say it is “optimized”; a rewrite may grow it or alter pixels. Preserve animation and transparency unless the merchant approves a change.

For unsupported still formats, inspect before conversion. With Pillow available:

```bash
python3 - <<'PY'
from PIL import Image
src, dst = "input.tiff", "output.webp"
with Image.open(src) as im:
    im.seek(0)
    im.load()
    if im.width * im.height > 100_000_000:
        raise SystemExit("image pixel count is unsafe")
    im.thumbnail((4096, 4096))
    im.save(dst, "WEBP", lossless=True, method=6)
PY
```

Use PNG rather than WebP when lossless WebP support is unavailable or the source requires exact wide-gamut/tool compatibility. HEIC/HEIF decoding depends on the local codec; fail with an actionable message rather than uploading mislabeled bytes. Never upload SVG directly.

On interruption, inspect the upload session and resume missing parts. Abort an unwanted session; do not initiate duplicates because output was overlooked.
