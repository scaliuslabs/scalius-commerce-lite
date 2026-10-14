/**
 * The browser image pipeline for uploads no Worker re-encodes (chat photos).
 * A Worker has no image service: the dashboard and the storefront scale a
 * photo down and encode it as WebP on the buyer's or staff member's own device
 * before it is sent. Canvas re-encoding also drops EXIF and GPS data.
 *
 * Browser-only (needs `createImageBitmap` and a canvas). Every failure returns
 * null so the caller can send the original and let the API give its reason.
 */

/** Longest edge kept; larger photos are scaled down. */
export const BROWSER_IMAGE_MAX_EDGE_PX = 2560;
const WEBP_QUALITY = 0.82;

type Surface = OffscreenCanvas | HTMLCanvasElement;

function createSurface(width: number, height: number): Surface {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function encodeWebp(surface: Surface): Promise<Blob | null> {
  if ("convertToBlob" in surface) return surface.convertToBlob({ type: "image/webp", quality: WEBP_QUALITY });
  return new Promise((resolve) => surface.toBlob(resolve, "image/webp", WEBP_QUALITY));
}

/**
 * `file` scaled to at most `maxEdge` pixels on its longest side (EXIF
 * orientation applied) and encoded as a still WebP named `<name>.webp`; null
 * when the browser cannot decode it or cannot encode WebP (some browsers fall
 * back to PNG from the canvas, which is detected by the returned type).
 */
export async function encodeImageAsWebp(
  file: File,
  maxEdge: number = BROWSER_IMAGE_MAX_EDGE_PX,
): Promise<File | null> {
  if (typeof createImageBitmap !== "function") return null;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = longest > maxEdge ? maxEdge / longest : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const surface = createSurface(width, height);
    const context = surface.getContext("2d") as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!context) return null;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await encodeWebp(surface);
    if (!blob || blob.type !== "image/webp") return null;
    const base = file.name.replace(/\.[A-Za-z0-9]{1,5}$/, "") || "photo";
    return new File([blob], `${base}.webp`, { type: "image/webp" });
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}
