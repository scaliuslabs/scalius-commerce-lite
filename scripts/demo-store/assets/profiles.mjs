export const ASSET_PROFILES = Object.freeze({
  "product-contain": Object.freeze({
    kind: "image",
    width: 1600,
    height: 1600,
    fit: "contain-safe",
    safeArea: 0.8,
    format: "webp",
    quality: 86,
  }),
  "product-cover": Object.freeze({
    kind: "image",
    width: 1600,
    height: 1600,
    fit: "cover",
    format: "webp",
    quality: 86,
  }),
  category: Object.freeze({
    kind: "image",
    width: 1600,
    height: 1000,
    fit: "cover",
    format: "webp",
    quality: 86,
  }),
  "hero-desktop": Object.freeze({
    kind: "image",
    width: 2400,
    height: 900,
    fit: "cover",
    format: "webp",
    quality: 86,
  }),
  "hero-mobile": Object.freeze({
    kind: "image",
    width: 1080,
    height: 1350,
    fit: "cover",
    format: "webp",
    quality: 86,
  }),
  video: Object.freeze({ kind: "video", fit: "copy" }),
});

export const IMAGE_MIME_LIMIT_BYTES = 20 * 1024 * 1024;
export const VIDEO_MIME_LIMIT_BYTES = 100 * 1024 * 1024;

export const IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
]);
export const VIDEO_MIMES = new Set(["video/mp4", "video/webm"]);

export function deterministicAssetFilename(asset, sourceSha256) {
  const stem = asset.logicalKey
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  const extension = asset.kind === "video"
    ? asset.mime === "video/webm" ? "webm" : "mp4"
    : "webp";
  return `${stem}--${asset.profile}--${sourceSha256.slice(0, 12)}.${extension}`;
}
