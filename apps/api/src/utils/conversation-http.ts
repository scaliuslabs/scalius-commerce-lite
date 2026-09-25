// HTTP helpers shared by the buyer and staff conversation routes (Wave A §4.3):
// buyer write limits (C8), image upload re-encoding and private attachment
// serving (C7). Logs carry ids only; bodies, contacts and receipt proof never
// reach a log line, a URL or a limiter key in clear.

import type { Context } from "hono";
import { CONVERSATION_LIMITS } from "@scalius/shared/conversation";
import { detectMediaMimeType, MEDIA_SIGNATURE_READ_BYTES } from "@scalius/shared/media-policy";
import { RateLimitError, ServiceUnavailableError, ValidationError } from "./api-error";
import { getTrustedClientIp } from "./client-ip";
import { isWithinRateLimit } from "./rate-limit";

/**
 * Every buyer write (post, start a thread, upload, submit a case) passes both
 * limiters: RL_STRICT per buyer (customer or receipt order) and RL_STANDARD
 * per IP. A missing binding fails closed (ServiceUnavailableError).
 */
export async function enforceBuyerWriteLimits(
  c: Context<{ Bindings: Env }>,
  purpose: string,
  buyer: { customerId: string } | { orderId: string },
): Promise<void> {
  const subject = "customerId" in buyer ? `customer:${buyer.customerId}` : `receipt:${buyer.orderId}`;
  const ip = getTrustedClientIp(c);
  const [perBuyer, perIp] = await Promise.all([
    isWithinRateLimit(c.env, "RL_STRICT", `conversation:${purpose}`, subject),
    isWithinRateLimit(c.env, "RL_STANDARD", `conversation:${purpose}:ip`, ip),
  ]);
  if (!perBuyer || !perIp) {
    throw new RateLimitError("You're sending too quickly. Please wait a moment and try again.");
  }
}

const UPLOAD_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
/** Multipart framing on top of the 5 MiB file. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
/** Longest edge kept after re-encoding; larger photos are scaled down. */
const MAX_EDGE_PX = 2560;
const WEBP_QUALITY = 82;

export interface ReencodedAttachment {
  webp: ArrayBuffer;
  width: number | null;
  height: number | null;
}

/** The upload form (read once; Hono caches it for the validator). Rejects oversized bodies before parsing. */
export async function readAttachmentForm(c: Context<{ Bindings: Env }>): Promise<FormData> {
  const declaredLength = Number(c.req.header("content-length") ?? "0");
  if (declaredLength > CONVERSATION_LIMITS.attachmentBytes + MULTIPART_OVERHEAD_BYTES) {
    throw new ValidationError("Images must be 5 MB or smaller.");
  }
  try {
    return await c.req.formData();
  } catch {
    throw new ValidationError("Upload one image as multipart form data.");
  }
}

/** A text field of the upload form (thread or order id), never a file. */
export function formText(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : null;
}

/**
 * Reads one multipart `file`, checks its signature (JPEG, PNG or WebP only, by
 * content, never by the declared type) and re-encodes it to WebP through the
 * IMAGES binding. Re-encoding drops EXIF/GPS and any polyglot payload.
 */
export async function readAndReencodeAttachment(env: Env, form: FormData): Promise<ReencodedAttachment> {
  const images = env.IMAGES;
  if (!images) throw new ServiceUnavailableError("Image attachments are unavailable right now.");
  const file = form.get("file");
  if (!file || typeof file === "string") throw new ValidationError("Choose an image to upload.");
  if (file.size < 1 || file.size > CONVERSATION_LIMITS.attachmentBytes) {
    throw new ValidationError("Images must be 5 MB or smaller.");
  }
  const bytes = await file.arrayBuffer();
  const detected = detectMediaMimeType(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, MEDIA_SIGNATURE_READ_BYTES)));
  if (!detected || !UPLOAD_TYPES.has(detected)) {
    throw new ValidationError("Only JPEG, PNG or WebP images can be attached.");
  }

  let webp: ArrayBuffer;
  let width: number | null = null;
  let height: number | null = null;
  try {
    const info = await images.info(new Blob([bytes]).stream());
    if ("width" in info && "height" in info) {
      width = info.width;
      height = info.height;
    }
    const longest = Math.max(width ?? 0, height ?? 0);
    const scale = longest > MAX_EDGE_PX ? MAX_EDGE_PX / longest : 1;
    let pipeline = images.input(new Blob([bytes]).stream());
    if (scale < 1 && width && height) {
      pipeline = pipeline.transform({ width: Math.round(width * scale), height: Math.round(height * scale) });
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    const output = await pipeline.output({ format: "image/webp", quality: WEBP_QUALITY });
    webp = await output.response().arrayBuffer();
  } catch (error) {
    console.warn("[conversations] Image re-encode failed:", error instanceof Error ? error.message.slice(0, 120) : "unknown error");
    throw new ValidationError("That image couldn't be read. Try a different photo or a screenshot.");
  }
  if (webp.byteLength < 1 || webp.byteLength > CONVERSATION_LIMITS.attachmentBytes) {
    throw new ValidationError("Images must be 5 MB or smaller.");
  }
  // The stored object must be what we produced: WebP by signature.
  if (detectMediaMimeType(new Uint8Array(webp, 0, Math.min(webp.byteLength, MEDIA_SIGNATURE_READ_BYTES))) !== "image/webp") {
    throw new ValidationError("That image couldn't be converted.");
  }
  return { webp, width, height };
}

/** Streams a private attachment after the caller's access check. Never cached, never sniffed. */
export async function serveConversationAttachment(
  env: Env,
  attachment: { r2Key: string; mediaType: string; sizeBytes: number },
): Promise<Response> {
  const object = await env.BUCKET.get(attachment.r2Key);
  if (!object || !("body" in object) || !object.body) {
    return new Response(JSON.stringify({ success: false, error: { code: "NOT_FOUND", message: "Attachment not found" } }), {
      status: 404,
      headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
    });
  }
  return new Response(object.body, {
    status: 200,
    headers: {
      "Content-Type": attachment.mediaType,
      "Content-Length": String(attachment.sizeBytes),
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-site",
    },
  });
}
