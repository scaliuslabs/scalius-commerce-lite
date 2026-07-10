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

export interface UploadFileMetadata {
  customMetadata?: Record<string, string>;
  sha256?: ArrayBuffer | ArrayBufferView | string;
  objectKey?: string;
}

/**
 * R2 does not cancel an in-flight put when the caller's local deadline wins.
 * Callers must retain their deterministic object-key cleanup evidence when
 * this error is raised; a late successful put can still materialize.
 */
export class AmbiguousStorageWriteError extends ServiceUnavailableError {
  constructor() {
    super("Media storage timed out. The save was not confirmed.");
    this.name = "AmbiguousStorageWriteError";
  }
}

export function isAmbiguousStorageWriteError(
  error: unknown,
): error is AmbiguousStorageWriteError {
  return error instanceof AmbiguousStorageWriteError;
}

function boundedCustomMetadata(
  metadata: Record<string, string> | undefined,
): Record<string, string> {
  if (!metadata) return {};

  return Object.fromEntries(
    Object.entries(metadata)
      .filter(
        ([key, value]) =>
          /^[a-zA-Z0-9_-]{1,64}$/.test(key) && value.length <= 512,
      )
      .slice(0, 16),
  );
}

function validatedObjectKey(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const key = value.trim();
  if (
    key.length === 0 ||
    key.length > 320 ||
    key.startsWith("/") ||
    key.endsWith("/") ||
    key.includes("..") ||
    key.includes("//") ||
    !/^[A-Za-z0-9][A-Za-z0-9/_-]*\.[A-Za-z0-9]{1,10}$/u.test(key)
  ) {
    throw new ValidationError("Media storage key is invalid.");
  }
  return key;
}

function byteViewsEqual(
  left: ArrayBuffer | ArrayBufferView,
  right: ArrayBuffer | ArrayBufferView,
): boolean {
  const leftBytes = ArrayBuffer.isView(left)
    ? new Uint8Array(left.buffer, left.byteOffset, left.byteLength)
    : new Uint8Array(left);
  const rightBytes = ArrayBuffer.isView(right)
    ? new Uint8Array(right.buffer, right.byteOffset, right.byteLength)
    : new Uint8Array(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  return leftBytes.every((byte, index) => byte === rightBytes[index]);
}

function reconciledUploadMatches(
  object: R2Object,
  expectedSize: number,
  expectedSha256: UploadFileMetadata["sha256"],
): boolean {
  if (object.size !== expectedSize) return false;
  if (!expectedSha256 || typeof expectedSha256 === "string") return true;
  const storedSha256 = r2ObjectSha256(object);
  return Boolean(
    storedSha256 && byteViewsEqual(storedSha256, expectedSha256),
  );
}

function r2ObjectSha256(object: R2Object): ArrayBuffer | undefined {
  if (!("checksums" in object)) return undefined;
  const checksums = object.checksums;
  if (
    typeof checksums !== "object" ||
    checksums === null ||
    !("sha256" in checksums)
  ) return undefined;
  return checksums.sha256 instanceof ArrayBuffer
    ? checksums.sha256
    : undefined;
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
  metadata?: UploadFileMetadata,
): Promise<UploadResult> {
  const validation = validateImageFile(file);
  if (!validation.isValid) {
    throw new ValidationError(validation.error || "File validation failed");
  }

  const r2 = bucket ?? _bucket;
  if (!r2) {
    throw new ServiceUnavailableError("Media storage is temporarily unavailable.");
  }

  // Use the R2_PUBLIC_URL configured via initStorage() in middleware.
  // If not set, the URL field in the result will just be the bare key.
  const baseUrl = (publicUrl ?? _publicUrl) || "";
  const ext = file.name.split(".").pop();
  const key = validatedObjectKey(metadata?.objectKey, `${nanoid()}.${ext}`);

  let fileBuffer: ArrayBuffer;
  try {
    fileBuffer = await file.arrayBuffer();
  } catch {
    throw new ServiceUnavailableError("Media storage is temporarily unavailable.");
  }

  // Upload with timeout
  const uploadPromise = r2.put(key, fileBuffer, {
    httpMetadata: {
      contentType: file.type,
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: {
      ...boundedCustomMetadata(metadata?.customMetadata),
      originalFilename: file.name,
      uploadedAt: new Date().toISOString(),
    },
    ...(metadata?.sha256 ? { sha256: metadata.sha256 } : {}),
  });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Upload timeout after ${UPLOAD_TIMEOUT} ms`)),
      UPLOAD_TIMEOUT,
    );
  });

  try {
    await Promise.race([uploadPromise, timeoutPromise]);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("timeout")) {
      try {
        const reconciled = await r2.head(key);
        if (
          reconciled &&
          reconciledUploadMatches(reconciled, file.size, metadata?.sha256)
        ) {
          return {
            key,
            url: buildPublicUrl(baseUrl, key),
            size: file.size,
            filename: file.name,
            mimeType: file.type,
          };
        }
      } catch {
        // The deterministic key remains available to the caller for cleanup.
      }
      throw new AmbiguousStorageWriteError();
    }
    throw new ServiceUnavailableError("Media storage is temporarily unavailable.");
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
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
  } catch {
    throw new ServiceUnavailableError("Media storage is temporarily unavailable.");
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
