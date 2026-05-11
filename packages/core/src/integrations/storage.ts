// src/lib/storage.ts
// Cloudflare R2 storage – replaces AWS S3 SDK
import { nanoid } from "nanoid";
import { ValidationError, ServiceUnavailableError } from "@scalius/core/errors";

// Configuration constants
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const UPLOAD_TIMEOUT = 30_000; // 30 s

// Allowed MIME types for image uploads
const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/bmp",
  "image/tiff",
]);

const VALID_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "svg",
  "bmp",
  "tiff",
  "tif",
]);

// ---------------------------------------------------------------------------
// Module-level R2 state – set once per isolate from middleware / route handler
// ---------------------------------------------------------------------------
let _bucket: R2Bucket | undefined;
let _publicUrl: string = "";

/** Register the R2 binding and public URL for this isolate. */
export function initStorage(bucket: R2Bucket, publicUrl: string): void {
  _bucket = bucket;
  _publicUrl = publicUrl.replace(/\/$/, ""); // strip trailing slash
}

/** Returns the registered R2 bucket (may be undefined before initStorage). */
export function getBucket(): R2Bucket | undefined {
  return _bucket;
}

function buildPublicUrl(baseUrl: string, key: string): string {
  const normalizedBase = baseUrl.trim().replace(/\/$/, "");
  return normalizedBase ? `${normalizedBase}/${key}` : key;
}

// ---------------------------------------------------------------------------
// File validation
// ---------------------------------------------------------------------------
function validateImageFile(file: File): { isValid: boolean; error?: string } {
  if (!file) return { isValid: false, error: "No file provided" };
  if (file.size === 0)
    return { isValid: false, error: "File is empty (0 bytes)" };

  if (file.size > MAX_FILE_SIZE) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
    return {
      isValid: false,
      error: `File size (${sizeMB} MB) exceeds the 10 MB limit`,
    };
  }

  if (!file.type) {
    return { isValid: false, error: "File type could not be determined" };
  }

  if (!ALLOWED_IMAGE_TYPES.has(file.type.toLowerCase())) {
    return {
      isValid: false,
      error: `Unsupported file type: ${file.type}. Allowed: JPEG, PNG, GIF, WebP, SVG, BMP, TIFF`,
    };
  }

  if (!file.name?.trim()) {
    return { isValid: false, error: "Invalid file name" };
  }

  const ext = file.name.split(".").pop()?.toLowerCase();
  if (!ext || !VALID_EXTENSIONS.has(ext)) {
    return {
      isValid: false,
      error: `Invalid file extension. Allowed: ${[...VALID_EXTENSIONS].join(", ")}`,
    };
  }

  return { isValid: true };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface UploadResult {
  key: string;
  url: string;
  size: number;
  filename: string;
  mimeType: string;
}

/**
 * Upload a file to Cloudflare R2.
 *
 * @param file    The file to upload (from FormData)
 * @param bucket  R2Bucket binding override; falls back to the module-level binding
 * @param publicUrl  Public base URL override; falls back to the module-level value
 */
export async function uploadFile(
  file: File,
  bucket?: R2Bucket,
  publicUrl?: string,
): Promise<UploadResult> {
  const validation = validateImageFile(file);
  if (!validation.isValid) {
    throw new ValidationError(validation.error || "File validation failed");
  }

  const r2 = bucket ?? _bucket;
  if (!r2) {
    throw new ServiceUnavailableError(
      "R2 bucket binding is not available. " +
        "Pass the bucket argument explicitly or call initStorage() first.",
    );
  }

  // Use the R2_PUBLIC_URL configured via initStorage() in middleware.
  // If not set, the URL field in the result will just be the bare key.
  const baseUrl = (publicUrl ?? _publicUrl) || "";
  const ext = file.name.split(".").pop();
  const key = `${nanoid()}.${ext}`;

  let fileBuffer: ArrayBuffer;
  try {
    fileBuffer = await file.arrayBuffer();
  } catch (err: unknown) {
    throw new ServiceUnavailableError(
      `Failed to read file: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }

  // Upload with timeout
  const uploadPromise = r2.put(key, fileBuffer, {
    httpMetadata: {
      contentType: file.type,
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: {
      originalFilename: file.name,
      uploadedAt: new Date().toISOString(),
    },
  });

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`Upload timeout after ${UPLOAD_TIMEOUT} ms`)),
      UPLOAD_TIMEOUT,
    ),
  );

  try {
    await Promise.race([uploadPromise, timeoutPromise]);
  } catch (err: unknown) {
    let userMessage = err instanceof Error ? err.message : "Upload failed";
    if (userMessage.includes("timeout"))
      userMessage =
        "Upload timeout – file may be too large or connection is slow";
    if (userMessage.includes("NetworkingError"))
      userMessage = "Network error – please check your connection";
    throw new ServiceUnavailableError(userMessage);
  }

  return {
    key,
    url: buildPublicUrl(baseUrl, key),
    size: file.size,
    filename: file.name,
    mimeType: file.type,
  };
}

/**
 * Delete a file from Cloudflare R2.
 */
export async function deleteFile(
  key: string,
  bucket?: R2Bucket,
): Promise<void> {
  const r2 = bucket ?? _bucket;
  if (!r2) {
    throw new ServiceUnavailableError("R2 bucket binding is not available.");
  }

  try {
    await r2.delete(key);
    console.log(`[R2] Deleted: ${key}`);
  } catch (err: unknown) {
    throw new ServiceUnavailableError(
      `Failed to delete file: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

/**
 * Extract the R2 object key from a full public URL.
 */
export function extractKeyFromUrl(url: string): string | null {
  const raw = url.trim();
  if (!raw) return null;

  const fromPathname = (pathname: string): string | null => {
    const mediaRouteMarker = "/api/v1/media/";
    const mediaRouteIndex = pathname.indexOf(mediaRouteMarker);
    if (mediaRouteIndex >= 0) {
      const key = pathname.slice(mediaRouteIndex + mediaRouteMarker.length);
      return key || null;
    }

    const resizeMarker = "/cdn-cgi/image/";
    const resizeIndex = pathname.indexOf(resizeMarker);
    if (resizeIndex >= 0) {
      const resizedPath = pathname.slice(resizeIndex + resizeMarker.length);
      const originalPathIndex = resizedPath.indexOf("/");
      if (originalPathIndex >= 0) {
        const key = resizedPath.slice(originalPathIndex + 1);
        return key.replace(/^\/+/, "") || null;
      }
    }

    return pathname.replace(/^\/+/, "") || null;
  };

  try {
    return fromPathname(new URL(raw).pathname);
  } catch {
    return raw.replace(/^\/+/, "") || null;
  }
}
