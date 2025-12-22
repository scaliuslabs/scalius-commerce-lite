import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { nanoid } from "nanoid";

// Environment variables
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID!;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID!;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY!;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME!;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL!;

// Configuration constants
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const UPLOAD_TIMEOUT = 30000; // 30 seconds
const MAX_RETRIES = 2;
const RETRY_DELAY = 1000; // 1 second

// Allowed MIME types for images
const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/bmp",
  "image/tiff",
];

// Validate environment variables
if (
  !R2_ACCOUNT_ID ||
  !R2_ACCESS_KEY_ID ||
  !R2_SECRET_ACCESS_KEY ||
  !R2_BUCKET_NAME ||
  !R2_PUBLIC_URL
) {
  throw new Error("Missing required R2 environment variables");
}

/**
 * Create S3 client configured for Cloudflare R2 with proper XML parsing
 * This is critical for Workers environment where DOMParser is not available
 */
function createS3Client(): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
    // Critical: Configure XML parser for Cloudflare Workers
    // This fixes the "DOMParser is not defined" error
    requestHandler: {
      requestTimeout: UPLOAD_TIMEOUT,
    } as any,
  });
}

// Singleton S3 client instance
const s3 = createS3Client();

/**
 * Validate image file before upload
 */
function validateImageFile(file: File): { isValid: boolean; error?: string } {
  // Check if file exists
  if (!file) {
    return { isValid: false, error: "No file provided" };
  }

  // Check file size
  if (file.size === 0) {
    return { isValid: false, error: "File is empty (0 bytes)" };
  }

  if (file.size > MAX_FILE_SIZE) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
    return {
      isValid: false,
      error: `File size (${sizeMB}MB) exceeds maximum allowed size (10MB)`,
    };
  }

  // Check MIME type
  if (!file.type) {
    return {
      isValid: false,
      error: "File type could not be determined",
    };
  }

  if (!ALLOWED_IMAGE_TYPES.includes(file.type.toLowerCase())) {
    return {
      isValid: false,
      error: `Unsupported file type: ${file.type}. Allowed types: JPEG, PNG, GIF, WebP, SVG, BMP, TIFF`,
    };
  }

  // Check file name
  if (!file.name || file.name.trim() === "") {
    return { isValid: false, error: "Invalid file name" };
  }

  // Check for valid extension
  const extension = file.name.split(".").pop()?.toLowerCase();
  const validExtensions = ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "tiff", "tif"];
  if (!extension || !validExtensions.includes(extension)) {
    return {
      isValid: false,
      error: `Invalid file extension. Allowed: ${validExtensions.join(", ")}`,
    };
  }

  return { isValid: true };
}

/**
 * Sleep utility for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Upload file to R2 with retry logic and proper error handling
 */
export async function uploadFile(file: File): Promise<{
  key: string;
  url: string;
  size: number;
  filename: string;
  mimeType: string;
}> {
  // Validate file first
  const validation = validateImageFile(file);
  if (!validation.isValid) {
    throw new Error(validation.error || "File validation failed");
  }

  // Generate unique key
  const extension = file.name.split(".").pop();
  const key = `${nanoid()}.${extension}`;

  // Convert File to ArrayBuffer for upload
  let fileBuffer: ArrayBuffer;
  try {
    fileBuffer = await file.arrayBuffer();
  } catch (error: any) {
    console.error(`Failed to read file "${file.name}":`, error);
    throw new Error(`Failed to read file: ${error.message || "Unknown error"}`);
  }

  // Retry logic
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Create upload command
      const command = new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        Body: new Uint8Array(fileBuffer),
        ContentType: file.type,
        ContentLength: file.size,
        // Add metadata for better tracking
        Metadata: {
          originalFilename: file.name,
          uploadedAt: new Date().toISOString(),
        },
      });

      // Execute upload with timeout
      const uploadPromise = s3.send(command);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`Upload timeout after ${UPLOAD_TIMEOUT}ms`)),
          UPLOAD_TIMEOUT
        )
      );

      await Promise.race([uploadPromise, timeoutPromise]);

      // Success! Return file info
      return {
        key,
        url: `${R2_PUBLIC_URL}/${key}`,
        size: file.size,
        filename: file.name,
        mimeType: file.type,
      };
    } catch (error: any) {
      lastError = error;
      console.error(
        `Upload attempt ${attempt + 1}/${MAX_RETRIES + 1} failed for "${file.name}":`,
        error
      );

      // Don't retry on validation errors or client errors
      if (
        error.message?.includes("validation") ||
        error.message?.includes("Invalid") ||
        error.$metadata?.httpStatusCode === 400 ||
        error.$metadata?.httpStatusCode === 403
      ) {
        break;
      }

      // If not the last attempt, wait before retrying
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY * (attempt + 1); // Exponential backoff
        console.log(`Retrying upload for "${file.name}" in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  // All retries failed
  const errorMessage = lastError?.message || "Unknown upload error";
  console.error(`All upload attempts failed for "${file.name}":`, lastError);

  // Parse AWS SDK error for better user feedback
  let userFriendlyError = errorMessage;
  if (errorMessage.includes("timeout")) {
    userFriendlyError = "Upload timeout - file may be too large or connection is slow";
  } else if (errorMessage.includes("NetworkingError")) {
    userFriendlyError = "Network error - please check your connection";
  } else if (errorMessage.includes("AccessDenied")) {
    userFriendlyError = "Storage access denied - please contact support";
  } else if (errorMessage.includes("NoSuchBucket")) {
    userFriendlyError = "Storage bucket not found - please contact support";
  }

  throw new Error(userFriendlyError);
}

/**
 * Delete file from R2
 */
export async function deleteFile(key: string): Promise<void> {
  try {
    const command = new DeleteObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
    });

    await s3.send(command);
    console.log(`Successfully deleted file: ${key}`);
  } catch (error: any) {
    console.error(`Failed to delete file "${key}":`, error);
    throw new Error(`Failed to delete file: ${error.message || "Unknown error"}`);
  }
}

/**
 * Extract key from URL
 */
export function extractKeyFromUrl(url: string): string | null {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    // Remove leading slash
    return pathname.startsWith("/") ? pathname.slice(1) : pathname;
  } catch (error) {
    console.error("Failed to extract key from URL:", url, error);
    return null;
  }
}
