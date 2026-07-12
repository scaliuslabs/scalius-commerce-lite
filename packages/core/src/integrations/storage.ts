// src/lib/storage.ts
// Cloudflare R2 storage – replaces AWS S3 SDK
import { nanoid } from "nanoid";
import { ValidationError, ServiceUnavailableError } from "@scalius/core/errors";
import {
  MEDIA_MULTIPART_MAX_PARTS,
  MEDIA_MULTIPART_PART_SIZE_BYTES,
  MEDIA_POLICY,
  MEDIA_SIGNATURE_READ_BYTES,
  getMediaPolicy,
  validateMediaFileMetadata,
  validateMediaSignature,
  type SupportedMediaMimeType,
} from "@scalius/shared/media-policy";

// Configuration constants
const UPLOAD_TIMEOUT = 30_000; // 30 s
const CUSTOM_METADATA_MAX_ENTRIES = 16;
const CUSTOM_METADATA_MAX_KEY_LENGTH = 64;
const CUSTOM_METADATA_MAX_VALUE_LENGTH = 512;
const CUSTOM_METADATA_APP_BUDGET_BYTES = 4 * 1024;
const OBJECT_KEY_MAX_LENGTH = 320;
const MULTIPART_UPLOAD_ID_MAX_LENGTH = 512;
const MULTIPART_ETAG_MAX_LENGTH = 256;

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

export function getPublicMediaUrl(baseUrl: string, key: string): string {
  const normalizedBase = baseUrl.trim().replace(/\/+$/, "");
  const validatedKey = validateMediaObjectKey(key);
  return normalizedBase ? `${normalizedBase}/${validatedKey}` : validatedKey;
}

export function getCurrentPublicMediaUrl(
  key: string,
  publicUrl?: string,
): string {
  return getPublicMediaUrl((publicUrl ?? _publicUrl) || "", key);
}

// ---------------------------------------------------------------------------
// File validation
// ---------------------------------------------------------------------------
function validateImageFile(file: File) {
  return validateMediaFileMetadata({
    filename: file.name,
    mimeType: file.type,
    size: file.size,
    expectedKind: "image",
  });
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

  const output: Record<string, string> = {};
  let encodedBytes = 0;
  for (const [key, value] of Object.entries(metadata)) {
    if (Object.keys(output).length >= CUSTOM_METADATA_MAX_ENTRIES) break;
    if (
      !new RegExp(`^[a-zA-Z0-9_-]{1,${CUSTOM_METADATA_MAX_KEY_LENGTH}}$`).test(
        key,
      ) ||
      value.length > CUSTOM_METADATA_MAX_VALUE_LENGTH
    ) {
      continue;
    }
    const entryBytes = new TextEncoder().encode(`${key}:${value}`).byteLength;
    if (encodedBytes + entryBytes > CUSTOM_METADATA_APP_BUDGET_BYTES) break;
    output[key] = value;
    encodedBytes += entryBytes;
  }
  return output;
}

export function validateMediaObjectKey(
  value: string,
  expectedMimeType?: SupportedMediaMimeType,
): string {
  const key = value.trim();
  if (
    key.length === 0 ||
    key.length > OBJECT_KEY_MAX_LENGTH ||
    key.startsWith("/") ||
    key.endsWith("/") ||
    key.includes("..") ||
    key.includes("//") ||
    !/^[A-Za-z0-9][A-Za-z0-9/_-]*\.[A-Za-z0-9]{1,10}$/u.test(key)
  ) {
    throw new ValidationError("Media storage key is invalid.");
  }

  const extension = key.split(".").pop()?.toLowerCase() ?? "";
  const policy = expectedMimeType
    ? MEDIA_POLICY[expectedMimeType]
    : Object.values(MEDIA_POLICY).find((candidate) =>
        candidate.extensions.some((value) => value === extension),
      );
  if (!policy || !policy.extensions.some((value) => value === extension)) {
    throw new ValidationError("Media storage key extension is invalid.");
  }
  return key;
}

function validatedObjectKey(
  value: string | undefined,
  fallback: string,
  expectedMimeType: SupportedMediaMimeType,
): string {
  return validateMediaObjectKey(value ?? fallback, expectedMimeType);
}

export function buildMediaObjectKey(
  assetId: string,
  mimeType: SupportedMediaMimeType,
): string {
  const normalizedId = assetId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u.test(normalizedId)) {
    throw new ValidationError("Media asset ID is invalid.");
  }
  return validateMediaObjectKey(
    `media/${normalizedId}.${getMediaPolicy(mimeType).preferredExtension}`,
    mimeType,
  );
}

function validateMultipartUploadId(value: string): string {
  const uploadId = value.trim();
  if (
    uploadId.length === 0 ||
    uploadId.length > MULTIPART_UPLOAD_ID_MAX_LENGTH ||
    /[^\x21-\x7e]/u.test(uploadId)
  ) {
    throw new ValidationError("Media multipart upload ID is invalid.");
  }
  return uploadId;
}

function requireBucket(bucket?: R2Bucket): R2Bucket {
  const r2 = bucket ?? _bucket;
  if (!r2) {
    throw new ServiceUnavailableError("Media storage is temporarily unavailable.");
  }
  return r2;
}

function objectMetadata(input: {
  filename: string;
  kind: "image" | "video";
  size: number;
  customMetadata?: Record<string, string>;
}): Record<string, string> {
  const customMetadata = boundedCustomMetadata(input.customMetadata);
  delete customMetadata.originalFilename;
  delete customMetadata.mediaKind;
  delete customMetadata.declaredSize;
  delete customMetadata.uploadedAt;
  return boundedCustomMetadata({
    originalFilename: input.filename,
    mediaKind: input.kind,
    declaredSize: String(input.size),
    uploadedAt: new Date().toISOString(),
    ...customMetadata,
  });
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
  if (!validation.ok) {
    throw new ValidationError(validation.error);
  }
  const media = validation.value;

  const r2 = requireBucket(bucket);

  // Use the R2_PUBLIC_URL configured via initStorage() in middleware.
  // If not set, the URL field in the result will just be the bare key.
  const baseUrl = (publicUrl ?? _publicUrl) || "";
  const key = validatedObjectKey(
    metadata?.objectKey,
    `media/${nanoid()}.${media.extension}`,
    media.mimeType,
  );

  let signatureBytes: ArrayBuffer;
  try {
    signatureBytes = await file.slice(0, MEDIA_SIGNATURE_READ_BYTES).arrayBuffer();
  } catch {
    throw new ServiceUnavailableError("Media storage is temporarily unavailable.");
  }
  const signature = validateMediaSignature(signatureBytes, media.mimeType);
  if (!signature.ok) throw new ValidationError(signature.error);

  let fileBuffer: ArrayBuffer;
  try {
    fileBuffer = await file.arrayBuffer();
  } catch {
    throw new ServiceUnavailableError("Media storage is temporarily unavailable.");
  }

  // Upload with timeout
  const uploadPromise = r2.put(key, fileBuffer, {
    httpMetadata: {
      contentType: media.mimeType,
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: objectMetadata({
      filename: media.filename,
      kind: media.kind,
      size: media.size,
      customMetadata: metadata?.customMetadata,
    }),
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
            url: getPublicMediaUrl(baseUrl, key),
            size: file.size,
            filename: media.filename,
            mimeType: media.mimeType,
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
    url: getPublicMediaUrl(baseUrl, key),
    size: file.size,
    filename: media.filename,
    mimeType: media.mimeType,
  };
}

export interface CreateMediaMultipartUploadInput {
  objectKey: string;
  filename: string;
  mimeType: string;
  size: number;
  customMetadata?: Record<string, string>;
}

export interface MediaMultipartUploadHandle {
  key: string;
  uploadId: string;
  url: string;
}

export async function createMediaMultipartUpload(
  input: CreateMediaMultipartUploadInput,
  bucket?: R2Bucket,
  publicUrl?: string,
): Promise<MediaMultipartUploadHandle> {
  const validation = validateMediaFileMetadata(input);
  if (!validation.ok) throw new ValidationError(validation.error);
  const media = validation.value;
  const key = validateMediaObjectKey(input.objectKey, media.mimeType);
  const r2 = requireBucket(bucket);

  try {
    const upload = await r2.createMultipartUpload(key, {
      httpMetadata: {
        contentType: media.mimeType,
        cacheControl: "public, max-age=31536000, immutable",
      },
      customMetadata: objectMetadata({
        filename: media.filename,
        kind: media.kind,
        size: media.size,
        customMetadata: input.customMetadata,
      }),
    });
    return {
      key: upload.key,
      uploadId: upload.uploadId,
      url: getCurrentPublicMediaUrl(upload.key, publicUrl),
    };
  } catch {
    throw new ServiceUnavailableError("Media storage is temporarily unavailable.");
  }
}

/**
 * R2 resume is a local handle constructor and does not prove that the upload
 * still exists. Callers must retain durable session state and handle operation
 * failures as terminal/expired upload outcomes.
 */
export function resumeMediaMultipartUpload(
  objectKey: string,
  uploadId: string,
  bucket?: R2Bucket,
): R2MultipartUpload {
  const key = validateMediaObjectKey(objectKey);
  const validatedUploadId = validateMultipartUploadId(uploadId);
  return requireBucket(bucket).resumeMultipartUpload(key, validatedUploadId);
}

export type MediaMultipartPartValue =
  | ReadableStream
  | ArrayBuffer
  | ArrayBufferView
  | Blob;

function knownBodyLength(value: MediaMultipartPartValue): number | null {
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof Blob) return value.size;
  return null;
}

export async function uploadMediaMultipartPart(input: {
  objectKey: string;
  uploadId: string;
  partNumber: number;
  size: number;
  isFinal: boolean;
  value: MediaMultipartPartValue;
  bucket?: R2Bucket;
}): Promise<R2UploadedPart> {
  if (
    !Number.isInteger(input.partNumber) ||
    input.partNumber < 1 ||
    input.partNumber > MEDIA_MULTIPART_MAX_PARTS
  ) {
    throw new ValidationError("Media multipart part number is invalid.");
  }
  if (
    !Number.isSafeInteger(input.size) ||
    input.size < 1 ||
    input.size > MEDIA_MULTIPART_PART_SIZE_BYTES ||
    (!input.isFinal && input.size !== MEDIA_MULTIPART_PART_SIZE_BYTES)
  ) {
    throw new ValidationError("Media multipart part size is invalid.");
  }
  const actualLength = knownBodyLength(input.value);
  if (actualLength !== null && actualLength !== input.size) {
    throw new ValidationError("Media multipart part length does not match.");
  }

  const upload = resumeMediaMultipartUpload(
    input.objectKey,
    input.uploadId,
    input.bucket,
  );
  try {
    return await upload.uploadPart(input.partNumber, input.value);
  } catch {
    throw new ServiceUnavailableError("Media storage is temporarily unavailable.");
  }
}

function validateCompletedParts(parts: R2UploadedPart[]): R2UploadedPart[] {
  if (parts.length < 1 || parts.length > MEDIA_MULTIPART_MAX_PARTS) {
    throw new ValidationError("Media multipart completion parts are invalid.");
  }
  const seen = new Set<number>();
  const validated = parts.map((part) => {
    if (
      !Number.isInteger(part.partNumber) ||
      part.partNumber < 1 ||
      part.partNumber > MEDIA_MULTIPART_MAX_PARTS ||
      seen.has(part.partNumber) ||
      part.etag.length < 1 ||
      part.etag.length > MULTIPART_ETAG_MAX_LENGTH ||
      [...part.etag].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x1f || code === 0x7f;
      })
    ) {
      throw new ValidationError("Media multipart completion parts are invalid.");
    }
    seen.add(part.partNumber);
    return { partNumber: part.partNumber, etag: part.etag };
  });
  const sorted = validated.sort((left, right) => left.partNumber - right.partNumber);
  if (sorted.some((part, index) => part.partNumber !== index + 1)) {
    throw new ValidationError("Media multipart completion parts are invalid.");
  }
  return sorted;
}

export async function completeMediaMultipartUpload(input: {
  objectKey: string;
  uploadId: string;
  parts: R2UploadedPart[];
  bucket?: R2Bucket;
}): Promise<R2Object> {
  const parts = validateCompletedParts(input.parts);
  const upload = resumeMediaMultipartUpload(
    input.objectKey,
    input.uploadId,
    input.bucket,
  );
  try {
    return await upload.complete(parts);
  } catch {
    throw new ServiceUnavailableError("Media storage is temporarily unavailable.");
  }
}

export async function abortMediaMultipartUpload(input: {
  objectKey: string;
  uploadId: string;
  bucket?: R2Bucket;
}): Promise<void> {
  const upload = resumeMediaMultipartUpload(
    input.objectKey,
    input.uploadId,
    input.bucket,
  );
  try {
    await upload.abort();
  } catch {
    throw new ServiceUnavailableError("Media storage is temporarily unavailable.");
  }
}

export async function headMediaObject(
  objectKey: string,
  bucket?: R2Bucket,
): Promise<R2Object | null> {
  const r2 = requireBucket(bucket);
  const key = validateMediaObjectKey(objectKey);
  try {
    return await r2.head(key);
  } catch {
    throw new ServiceUnavailableError("Media storage is temporarily unavailable.");
  }
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
