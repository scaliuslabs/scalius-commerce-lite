// HTTP helpers shared by the buyer and staff conversation routes (Wave A §4.3):
// buyer write limits (C8), image upload checks and private attachment
// serving (C7). Logs carry ids only; bodies, contacts and receipt proof never
// reach a log line, a URL or a limiter key in clear.

import type { Context } from "hono";
import { CONVERSATION_LIMITS } from "@scalius/shared/conversation";
import { detectMediaMimeType, MEDIA_SIGNATURE_READ_BYTES } from "@scalius/shared/media-policy";
import { readStillWebp } from "@scalius/shared/webp-info";
import { RateLimitError, ValidationError } from "./api-error";
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

/** The types a browser may send; only the WebP its pipeline produced is stored. */
const UPLOAD_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
/** Multipart framing on top of the 5 MiB file. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export interface AttachmentImage {
  webp: ArrayBuffer;
  width: number;
  height: number;
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
 * Reads one multipart `file`: a still WebP the browser pipeline already scaled
 * and re-encoded (the dashboard composer and the storefront form do this
 * before upload; no Worker re-encodes images). The container is checked end to
 * end and sized from its own header, never trusted by declared type, so what is
 * stored is a well-formed still image with nothing trailing it.
 */
export async function readAttachmentImage(form: FormData): Promise<AttachmentImage> {
  const file = form.get("file");
  if (!file || typeof file === "string") throw new ValidationError("Choose an image to upload.");
  if (file.size < 1 || file.size > CONVERSATION_LIMITS.attachmentBytes) {
    throw new ValidationError("Images must be 5 MB or smaller.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const detected = detectMediaMimeType(bytes.subarray(0, MEDIA_SIGNATURE_READ_BYTES));
  if (!detected || !UPLOAD_TYPES.has(detected)) {
    throw new ValidationError("Only JPEG, PNG or WebP images can be attached.");
  }
  const info = detected === "image/webp" ? readStillWebp(bytes) : null;
  if (!info) {
    throw new ValidationError("This image needs to be prepared in your browser first. Turn on JavaScript and choose the photo again.");
  }
  return { webp: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, width: info.width, height: info.height };
}

/** Streams a private attachment after the caller's access check. Never cached, never sniffed. */
export async function serveConversationAttachment(
  env: Env,
  attachment: { r2Key: string; mediaType: string; sizeBytes: number },
): Promise<Response> {
  const object = await env.BUCKET.get(attachment.r2Key);
  if (!object || !("body" in object) || !object.body) {
    return new Response(JSON.stringify({ success: false, error: { code: "not_found", message: "Attachment not found" } }), {
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
