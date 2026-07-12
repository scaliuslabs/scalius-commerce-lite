import type { MediaKind } from "@scalius/shared/media-policy";

const METADATA_TIMEOUT_MS = 10_000;

export interface IntrinsicMediaMetadata {
  width: number;
  height: number;
  durationMs?: number;
}

export function normalizeIntrinsicMediaMetadata(
  kind: MediaKind,
  input: { width: number; height: number; durationSeconds?: number },
): IntrinsicMediaMetadata | null {
  const width = Math.round(input.width);
  const height = Math.round(input.height);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }

  if (kind === "image") return { width, height };
  const durationMs = Math.round((input.durationSeconds ?? 0) * 1_000);
  return Number.isSafeInteger(durationMs) && durationMs > 0
    ? { width, height, durationMs }
    : { width, height };
}

async function readImageMetadata(file: File): Promise<IntrinsicMediaMetadata | null> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    try {
      return normalizeIntrinsicMediaMetadata("image", bitmap);
    } finally {
      bitmap.close();
    }
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    return await new Promise((resolve) => {
      const image = new Image();
      const timeout = window.setTimeout(() => resolve(null), METADATA_TIMEOUT_MS);
      const settle = (value: IntrinsicMediaMetadata | null) => {
        window.clearTimeout(timeout);
        resolve(value);
      };
      image.onload = () => settle(normalizeIntrinsicMediaMetadata("image", {
        width: image.naturalWidth,
        height: image.naturalHeight,
      }));
      image.onerror = () => settle(null);
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function readVideoMetadata(file: File): Promise<IntrinsicMediaMetadata | null> {
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  try {
    return await new Promise((resolve) => {
      const timeout = window.setTimeout(() => resolve(null), METADATA_TIMEOUT_MS);
      const settle = (value: IntrinsicMediaMetadata | null) => {
        window.clearTimeout(timeout);
        resolve(value);
      };
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      video.onloadedmetadata = () => settle(normalizeIntrinsicMediaMetadata("video", {
        width: video.videoWidth,
        height: video.videoHeight,
        durationSeconds: video.duration,
      }));
      video.onerror = () => settle(null);
      video.src = objectUrl;
      video.load();
    });
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Reads browser-verified presentation hints while the local File is available.
 * Failure is non-fatal: the blob remains valid and the merchant can still use
 * it, but duration/dimensions stay unknown rather than being fabricated.
 */
export async function readIntrinsicMediaMetadata(
  file: File,
  kind: MediaKind,
): Promise<IntrinsicMediaMetadata | null> {
  try {
    return kind === "image"
      ? await readImageMetadata(file)
      : await readVideoMetadata(file);
  } catch {
    return null;
  }
}
