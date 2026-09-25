// Conversation image attachments (Wave A §4.3, C7). The API Worker sniffs the
// upload, re-encodes it to WebP through the IMAGES binding (stripping EXIF/GPS
// and neutralising polyglots) and stores it under the private R2 prefix; this
// module records, authorises, serves and sweeps those objects. Attachments are
// never public: every read goes through a thread access check.

import type { Database } from "@scalius/database/client";
import { conversationAttachments, conversationMessages } from "@scalius/database/schema";
import {
  CONVERSATION_ATTACHMENT_STORED_TYPE,
  CONVERSATION_LIMITS,
  conversationAttachmentR2Key,
} from "@scalius/shared/conversation";
import { and, asc, eq, isNull, lt } from "drizzle-orm";
import { NotFoundError, RateLimitError, ValidationError } from "../../errors";
import { newConversationAttachmentId } from "./threads";
import type { ConversationActor } from "./types";

/** Staged but unattached uploads one uploader may hold per thread at once. */
const MAX_STAGED_PER_UPLOADER = 6;
const SWEEP_BATCH = 50;

function uploaderFor(actor: ConversationActor): { type: "customer" | "guest_receipt" | "staff"; ref: string } {
  if (actor.kind === "customer") return { type: "customer", ref: actor.customerId };
  if (actor.kind === "guest_receipt") return { type: "guest_receipt", ref: actor.orderId };
  return { type: "staff", ref: actor.userId };
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface StagedAttachment {
  id: string;
  conversationId: string;
  mediaType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
}

/**
 * Stores already re-encoded WebP bytes for a thread and records the unattached
 * row. The object is written first; a failed row insert deletes it again.
 */
export async function stageConversationAttachment(
  db: Database,
  bucket: R2Bucket,
  input: {
    conversationId: string;
    actor: ConversationActor;
    webp: ArrayBuffer;
    width: number | null;
    height: number | null;
  },
): Promise<StagedAttachment> {
  const sizeBytes = input.webp.byteLength;
  if (sizeBytes < 1 || sizeBytes > CONVERSATION_LIMITS.attachmentBytes) {
    throw new ValidationError("Images must be 5 MB or smaller.");
  }
  const uploader = uploaderFor(input.actor);
  const staged = await db
    .select({ id: conversationAttachments.id })
    .from(conversationAttachments)
    .where(and(
      eq(conversationAttachments.conversationId, input.conversationId),
      isNull(conversationAttachments.messageId),
      eq(conversationAttachments.uploaderType, uploader.type),
      eq(conversationAttachments.uploaderRef, uploader.ref),
    ))
    .limit(MAX_STAGED_PER_UPLOADER)
    .all();
  if (staged.length >= MAX_STAGED_PER_UPLOADER) {
    throw new RateLimitError("Send or remove the images you already added first.");
  }

  const id = newConversationAttachmentId();
  const r2Key = conversationAttachmentR2Key(input.conversationId, id);
  const sha256 = await sha256Hex(input.webp);
  await bucket.put(r2Key, input.webp, {
    httpMetadata: { contentType: CONVERSATION_ATTACHMENT_STORED_TYPE },
  });
  try {
    await db.insert(conversationAttachments).values({
      id,
      conversationId: input.conversationId,
      uploaderType: uploader.type,
      uploaderRef: uploader.ref,
      r2Key,
      mediaType: CONVERSATION_ATTACHMENT_STORED_TYPE,
      sizeBytes,
      width: input.width && input.width > 0 ? Math.round(input.width) : null,
      height: input.height && input.height > 0 ? Math.round(input.height) : null,
      sha256,
      createdAt: Math.floor(Date.now() / 1000),
    });
  } catch (error) {
    await bucket.delete(r2Key).catch(() => undefined);
    throw error;
  }
  return {
    id,
    conversationId: input.conversationId,
    mediaType: CONVERSATION_ATTACHMENT_STORED_TYPE,
    sizeBytes,
    width: input.width,
    height: input.height,
  };
}

/**
 * The stored object key of an attachment this reader may see. Buyers see
 * attachments of public lines in their thread, and their own staged uploads;
 * staff see every attachment of the thread.
 */
export async function resolveConversationAttachment(
  db: Database,
  input: { conversationId: string; attachmentId: string; reader: ConversationActor },
): Promise<{ r2Key: string; mediaType: string; sizeBytes: number }> {
  const row = await db
    .select({
      r2Key: conversationAttachments.r2Key,
      mediaType: conversationAttachments.mediaType,
      sizeBytes: conversationAttachments.sizeBytes,
      messageId: conversationAttachments.messageId,
      uploaderType: conversationAttachments.uploaderType,
      uploaderRef: conversationAttachments.uploaderRef,
      visibility: conversationMessages.visibility,
    })
    .from(conversationAttachments)
    .leftJoin(conversationMessages, eq(conversationMessages.id, conversationAttachments.messageId))
    .where(and(
      eq(conversationAttachments.id, input.attachmentId),
      eq(conversationAttachments.conversationId, input.conversationId),
    ))
    .get();
  if (!row) throw new NotFoundError("Attachment not found");
  if (input.reader.kind !== "staff") {
    const uploader = uploaderFor(input.reader);
    const ownStaged = !row.messageId && row.uploaderType === uploader.type && row.uploaderRef === uploader.ref;
    if (!ownStaged && row.visibility !== "public") throw new NotFoundError("Attachment not found");
  }
  return { r2Key: row.r2Key, mediaType: row.mediaType, sizeBytes: row.sizeBytes };
}

/** Deletes uploads never attached within the orphan window (the 15-minute cron). */
export async function sweepOrphanConversationAttachments(
  db: Database,
  bucket: R2Bucket | undefined,
  options: { now?: number; limit?: number } = {},
): Promise<{ scanned: number; deleted: number }> {
  if (!bucket) return { scanned: 0, deleted: 0 };
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const rows = await db
    .select({ id: conversationAttachments.id, r2Key: conversationAttachments.r2Key })
    .from(conversationAttachments)
    .where(and(
      isNull(conversationAttachments.messageId),
      lt(conversationAttachments.createdAt, now - CONVERSATION_LIMITS.orphanAttachmentSeconds),
    ))
    .orderBy(asc(conversationAttachments.createdAt))
    .limit(Math.max(1, Math.min(options.limit ?? SWEEP_BATCH, SWEEP_BATCH)))
    .all();
  let deleted = 0;
  for (const row of rows) {
    // Delete the row first: if it was attached meanwhile, the guard keeps it
    // (and the object); a row gone with its object left behind is harmless.
    const removed = await db.delete(conversationAttachments)
      .where(and(eq(conversationAttachments.id, row.id), isNull(conversationAttachments.messageId)))
      .returning({ id: conversationAttachments.id })
      .catch(() => []);
    if (removed.length === 0) continue;
    await bucket.delete(row.r2Key).catch((error: unknown) => {
      console.error(`[conversations] Orphan attachment ${row.id} object not deleted:`, error instanceof Error ? error.message : "unknown error");
    });
    deleted += 1;
  }
  return { scanned: rows.length, deleted };
}
