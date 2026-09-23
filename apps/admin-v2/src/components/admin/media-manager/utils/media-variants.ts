import {
  mediaVariantQuality,
  mediaVariantWidths,
} from "@scalius/shared/media-variants";

/** Images whose renditions are generated; GIFs keep their animation. */
const VARIANT_SOURCE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);

export interface EncodedMediaVariants {
  width: number;
  height: number;
  files: Map<number, Blob>;
}

export function canEncodeMediaVariants(mimeType: string): boolean {
  return VARIANT_SOURCE_TYPES.has(mimeType);
}

type Surface = OffscreenCanvas | HTMLCanvasElement;

function createSurface(width: number, height: number): Surface {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function encodeWebp(surface: Surface, quality: number): Promise<Blob | null> {
  if ("convertToBlob" in surface) {
    return surface.convertToBlob({ type: "image/webp", quality });
  }
  return new Promise((resolve) => surface.toBlob(resolve, "image/webp", quality));
}

/**
 * Generates the fixed WebP rendition ladder in the browser. Each step is drawn
 * from the next larger one, so every downscale is at most ~2.5x and stays
 * sharp. Returns null when the browser cannot decode the file or cannot
 * encode WebP; the upload then stays original-only (or the server fills in).
 */
export async function encodeMediaVariants(source: Blob): Promise<EncodedMediaVariants | null> {
  if (typeof createImageBitmap !== "function") return null;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(source, { imageOrientation: "from-image" });
    const { width, height } = bitmap;
    const files = new Map<number, Blob>();
    let previous: CanvasImageSource = bitmap;
    for (const targetWidth of mediaVariantWidths(width).reverse()) {
      const targetHeight = Math.max(1, Math.round((height * targetWidth) / width));
      const surface = createSurface(targetWidth, targetHeight);
      const context = surface.getContext("2d") as
        | OffscreenCanvasRenderingContext2D
        | CanvasRenderingContext2D
        | null;
      if (!context) return null;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(previous, 0, 0, targetWidth, targetHeight);
      const blob = await encodeWebp(surface, mediaVariantQuality(targetWidth));
      if (!blob || blob.type !== "image/webp") return null;
      files.set(targetWidth, blob);
      previous = surface;
    }
    return files.size ? { width, height, files } : null;
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}
