import { mediaVariantQuality, mediaVariantWidths } from "./generated/media-variants.gen.js";

/** Images that get renditions; a GIF keeps its animation. Same set as the API. */
const RENDITION_SOURCE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);
/** The API refuses a rendition larger than one multipart part. */
const MAX_RENDITION_BYTES = 5 * 1024 * 1024;

export interface LocalRenditions {
  /** Intrinsic size of the original after EXIF orientation, as the API derives the ladder from it. */
  width: number;
  height: number;
  files: Array<{ width: number; bytes: Buffer }>;
}

interface SharpPipeline {
  rotate(): SharpPipeline;
  resize(options: { width: number; withoutEnlargement: boolean }): SharpPipeline;
  webp(options: { quality: number }): SharpPipeline;
  metadata(): Promise<{ width?: number; height?: number; orientation?: number }>;
  toBuffer(): Promise<Buffer>;
}

interface SharpModule {
  (input: string, options?: { failOn?: "error" }): SharpPipeline;
  cache(enabled: boolean): unknown;
}

let sharpLoad: Promise<SharpModule | null> | undefined;

/**
 * `sharp` is an optional dependency: one package decodes JPEG, PNG, WebP and
 * AVIF, applies EXIF orientation and resamples with libvips, so the CLI needs
 * no second decoder. Where its prebuilt binary is not installed the upload
 * still succeeds and the images stay pending for the dashboard to render.
 */
async function loadSharp(): Promise<SharpModule | null> {
  sharpLoad ??= import("sharp").then(
    (module) => {
      const sharp = (module as unknown as { default: SharpModule }).default;
      sharp.cache(false);
      return sharp;
    },
    () => null,
  );
  return sharpLoad;
}

export function canHaveRenditions(mimeType: string): boolean {
  return RENDITION_SOURCE_TYPES.has(mimeType);
}

/**
 * Encodes the fixed WebP ladder for one local image: the same widths and
 * qualities as the dashboard browser pipeline (`mediaVariantWidths` and
 * `mediaVariantQuality`, copied from @scalius/shared at generation time).
 * Returns null when the image cannot get renditions, sharp is unavailable, the
 * file cannot be decoded, or a rendition would exceed the API's size limit.
 */
export async function encodeLocalRenditions(path: string, mimeType: string): Promise<LocalRenditions | null> {
  if (!canHaveRenditions(mimeType)) return null;
  const sharp = await loadSharp();
  if (!sharp) return null;
  try {
    const metadata = await sharp(path, { failOn: "error" }).metadata();
    const rotated = (metadata.orientation ?? 1) >= 5;
    const width = rotated ? metadata.height : metadata.width;
    const height = rotated ? metadata.width : metadata.height;
    if (!width || !height) return null;
    const files: LocalRenditions["files"] = [];
    for (const target of mediaVariantWidths(width)) {
      let pipeline = sharp(path, { failOn: "error" }).rotate();
      if (target < width) pipeline = pipeline.resize({ width: target, withoutEnlargement: true });
      const bytes = await pipeline.webp({ quality: Math.round(mediaVariantQuality(target) * 100) }).toBuffer();
      if (bytes.byteLength < 1 || bytes.byteLength > MAX_RENDITION_BYTES) return null;
      files.push({ width: target, bytes });
    }
    return files.length > 0 ? { width, height, files } : null;
  } catch {
    return null;
  }
}
