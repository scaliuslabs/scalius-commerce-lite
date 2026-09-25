// Warranty claims (Wave B §5.2): a record plus a `warranty_claim` thread.
//
// Opening a claim is one batch: (the thread when it isn't reserved yet), the
// claim row, the opening event line and the opener's description as the first
// public message with its staged images, plus that message's notification
// outbox row. Buyers (the account that owns the order, or a guest with the
// order's receipt proof) may claim only an active warranty: not voided and not
// expired, re-checked inside the batch. Staff may also open a goodwill claim
// on an expired warranty. At most one claim per warranty is open at a time
// (a partial unique index).
//
// Images come first: "Make a claim" uploads them into the claim's reserved
// thread (an empty `warranty_claim` conversation, invisible in every list
// until its first line), keyed by the claim id the form's client key derives.
//
// Claims are records (W5): nothing here moves money, stock, fulfilment or the
// order's status. A replacement goes through a manual order or a return, a
// refund through the refund dialog, both started by staff from the order.

import type { Database } from "@scalius/database/client";
import { buildBatchGuard, isBatchGuardError, safeBatch } from "@scalius/database/client";
import {
  conversationAttachments,
  conversations,
  orderItemWarranties,
  orderItems,
  orders,
  products,
  warrantyClaims,
  warrantyPolicyRevisions,
} from "@scalius/database/schema";
import {
  WARRANTY_CLAIM_RESOLUTIONS,
  isWarrantyClaimResolution,
  isWarrantyClaimStatus,
  type WarrantyClaimOpener,
  type WarrantyClaimResolution,
  type WarrantyClaimStatus,
  type WarrantyDurationUnit,
  type WarrantyProvider,
} from "@scalius/shared/warranty";
import { CONVERSATION_LIMITS, normalizeConversationBody } from "@scalius/shared/conversation";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { and, desc, eq, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { ConflictError, NotFoundError, ValidationError } from "../../errors";
import {
  enqueueConversationNotifications,
  planConversationAppend,
  readThread,
  stageConversationAttachment,
  type ConversationActor,
  type ConversationLine,
  type StagedAttachment,
} from "../conversations";
import {
  CLAIM_CLIENT_KEY_PATTERN,
  claimAlreadyOpen,
  claimIdFor,
  claimOpenedLine,
  claimStatusLine,
  claimSubject,
  errorText,
  nowSeconds,
  staleClaim,
  warrantyExpired,
  warrantyNotActive,
  type BatchStatement,
} from "./shared";

const WARRANTY_INACTIVE_GUARD = "WARRANTY_NOT_ACTIVE";
const CLAIM_VERSION_GUARD = "WARRANTY_CLAIM_CHANGED";
const APPEND_ATTEMPTS = 3;
const CLAIM_LIST_PAGE = 25;

/** The notification queue the conversation outbox rows are handed to. */
type NotificationQueue = NonNullable<Parameters<typeof enqueueConversationNotifications>[1]>;

/** Who opens a claim. Buyers are proven by the route (session or receipt proof). */
export type ClaimActor = ConversationActor;

// ─────────────────────────────────────────
// The warranty a claim is about
// ─────────────────────────────────────────

export interface ClaimableWarranty {
  id: string;
  orderId: string;
  orderItemId: string;
  quantity: number;
  startsAt: number;
  expiresAt: number;
  replacementUntil: number | null;
  voidedAt: number | null;
  accountOwnerCustomerId: string | null;
  productName: string | null;
  variantLabel: string | null;
}

async function readClaimableWarranty(db: Database, warrantyId: string): Promise<ClaimableWarranty | undefined> {
  return await db
    .select({
      id: orderItemWarranties.id,
      orderId: orderItemWarranties.orderId,
      orderItemId: orderItemWarranties.orderItemId,
      quantity: orderItemWarranties.quantity,
      startsAt: orderItemWarranties.startsAt,
      expiresAt: orderItemWarranties.expiresAt,
      replacementUntil: orderItemWarranties.replacementUntil,
      voidedAt: orderItemWarranties.voidedAt,
      accountOwnerCustomerId: orders.accountOwnerCustomerId,
      productName: orderItems.productName,
      variantLabel: orderItems.variantLabel,
    })
    .from(orderItemWarranties)
    .innerJoin(orders, and(eq(orders.id, orderItemWarranties.orderId), isNull(orders.deletedAt)))
    .innerJoin(orderItems, eq(orderItems.id, orderItemWarranties.orderItemId))
    .where(eq(orderItemWarranties.id, warrantyId))
    .get();
}

/** The warranty when this actor may see it; 404 otherwise (ids are never confirmed). */
async function accessibleWarranty(db: Database, actor: ClaimActor, warrantyId: string): Promise<ClaimableWarranty> {
  const warranty = await readClaimableWarranty(db, warrantyId);
  if (!warranty) throw new NotFoundError("Warranty not found");
  if (actor.kind === "guest_receipt" && actor.orderId !== warranty.orderId) throw new NotFoundError("Warranty not found");
  if (actor.kind === "customer" && warranty.accountOwnerCustomerId !== actor.customerId) {
    throw new NotFoundError("Warranty not found");
  }
  return warranty;
}

/** Buyers claim only active warranties; staff may claim expired ones (goodwill), never voided ones. */
function assertClaimable(actor: ClaimActor, warranty: ClaimableWarranty, now: number): void {
  if (warranty.voidedAt !== null) {
    throw warrantyNotActive("This warranty ended when the delivery was cancelled. Message the store about the order if you need help.");
  }
  if (actor.kind !== "staff" && warranty.expiresAt <= now) throw warrantyExpired(warranty.expiresAt);
}

async function openClaimOn(db: Database, warrantyId: string): Promise<{ id: string; conversationId: string } | undefined> {
  return await db
    .select({ id: warrantyClaims.id, conversationId: warrantyClaims.conversationId })
    .from(warrantyClaims)
    .where(and(eq(warrantyClaims.warrantyId, warrantyId), inArray(warrantyClaims.status, ["open", "in_progress"])))
    .get();
}

function normalizeClientKey(clientKey: unknown): string {
  if (typeof clientKey !== "string" || !CLAIM_CLIENT_KEY_PATTERN.test(clientKey.trim())) {
    throw new ValidationError("Reload the page and try again.", { field: "clientKey" });
  }
  return clientKey.trim();
}

function reservedThread(db: Database, claimId: string) {
  return db
    .select()
    .from(conversations)
    .where(and(eq(conversations.subjectType, "warranty_claim"), eq(conversations.subjectId, claimId)))
    .get();
}

/**
 * The claim's thread before the claim exists: an empty `warranty_claim`
 * conversation whose subject id is the claim id. It carries no line, so no
 * list shows it until the claim's batch writes the first one.
 */
async function reserveClaimThread(db: Database, claimId: string, warranty: ClaimableWarranty) {
  const existing = await reservedThread(db, claimId);
  if (existing) {
    if (existing.orderId !== warranty.orderId) throw new NotFoundError("Warranty not found");
    return existing;
  }
  const now = nowSeconds();
  await db.insert(conversations).values({
    id: `cnv_${nanoid(20)}`,
    subjectType: "warranty_claim",
    subjectId: claimId,
    orderId: warranty.orderId,
    subject: claimSubject(warranty),
    status: "open",
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();
  const created = await reservedThread(db, claimId);
  if (!created) throw new ConflictError("The claim could not be started. Please try again.");
  return created;
}

/**
 * Stages one re-encoded image for a claim that is about to be opened (the
 * form's client key names it). Refused when the warranty isn't claimable or
 * already has an open claim, so a buyer never uploads for a claim that can't
 * be made.
 */
export async function stageWarrantyClaimAttachment(
  db: Database,
  bucket: R2Bucket,
  input: {
    warrantyId: string;
    clientKey: string;
    actor: ClaimActor;
    webp: ArrayBuffer;
    width: number | null;
    height: number | null;
  },
): Promise<StagedAttachment & { claimId: string }> {
  const clientKey = normalizeClientKey(input.clientKey);
  const warranty = await accessibleWarranty(db, input.actor, input.warrantyId);
  assertClaimable(input.actor, warranty, nowSeconds());
  const claimId = await claimIdFor(warranty.id, clientKey);
  const existingClaim = await db.select({ id: warrantyClaims.id }).from(warrantyClaims).where(eq(warrantyClaims.id, claimId)).get();
  if (existingClaim) throw new ConflictError("This claim was already sent. Add more photos in its conversation.");
  const open = await openClaimOn(db, warranty.id);
  if (open) throw claimAlreadyOpen(open.conversationId);
  const thread = await reserveClaimThread(db, claimId, warranty);
  const staged = await stageConversationAttachment(db, bucket, {
    conversationId: thread.id,
    actor: input.actor,
    webp: input.webp,
    width: input.width,
    height: input.height,
  });
  return { ...staged, claimId };
}

// ─────────────────────────────────────────
// Opening a claim
// ─────────────────────────────────────────

export interface OpenClaimInput {
  warrantyId: string;
  actor: ClaimActor;
  description: unknown;
  clientKey: unknown;
  attachmentIds?: readonly string[];
  /** Units affected (1 by default, at most the warranty's quantity). */
  quantity?: number;
  /** Staff open from an order page: the warranty must belong to this order. */
  orderId?: string;
}

export interface OpenClaimResult {
  claimId: string;
  conversationId: string;
  orderId: string;
  status: WarrantyClaimStatus;
  created: boolean;
}

function openerFor(actor: ClaimActor): WarrantyClaimOpener {
  return actor.kind;
}

async function replayClaim(db: Database, claimId: string, warranty: ClaimableWarranty): Promise<OpenClaimResult | null> {
  const row = await db
    .select({ id: warrantyClaims.id, conversationId: warrantyClaims.conversationId, status: warrantyClaims.status, warrantyId: warrantyClaims.warrantyId })
    .from(warrantyClaims)
    .where(eq(warrantyClaims.id, claimId))
    .get();
  if (!row || row.warrantyId !== warranty.id) return null;
  return { claimId: row.id, conversationId: row.conversationId, orderId: warranty.orderId, status: row.status, created: false };
}

async function assertStagedAttachments(
  db: Database,
  conversationId: string | null,
  actor: ClaimActor,
  attachmentIds: readonly string[],
): Promise<void> {
  if (attachmentIds.length === 0) return;
  if (attachmentIds.length > CONVERSATION_LIMITS.attachmentsPerMessage) {
    throw new ValidationError(`Attach up to ${CONVERSATION_LIMITS.attachmentsPerMessage} photos.`);
  }
  if (new Set(attachmentIds).size !== attachmentIds.length) throw new ValidationError("Each photo can be attached once.");
  if (!conversationId) throw new ValidationError("A photo is missing. Add it again.");
  const uploader = actor.kind === "customer"
    ? { type: "customer" as const, ref: actor.customerId }
    : actor.kind === "guest_receipt"
      ? { type: "guest_receipt" as const, ref: actor.orderId }
      : { type: "staff" as const, ref: actor.userId };
  const rows = await db
    .select({ id: conversationAttachments.id })
    .from(conversationAttachments)
    .where(and(
      inArray(conversationAttachments.id, [...attachmentIds]),
      eq(conversationAttachments.conversationId, conversationId),
      isNull(conversationAttachments.messageId),
      eq(conversationAttachments.uploaderType, uploader.type),
      eq(conversationAttachments.uploaderRef, uploader.ref),
    ))
    .all();
  if (rows.length !== attachmentIds.length) throw new ValidationError("A photo is missing or already sent. Add it again.");
}

function activeWarrantyGuard(db: Database, warrantyId: string, staff: boolean) {
  return buildBatchGuard(db, staff
    ? sql`EXISTS (SELECT 1 FROM ${orderItemWarranties} WHERE ${orderItemWarranties.id} = ${warrantyId} AND ${orderItemWarranties.voidedAt} IS NULL)`
    : sql`EXISTS (
        SELECT 1 FROM ${orderItemWarranties}
        WHERE ${orderItemWarranties.id} = ${warrantyId}
          AND ${orderItemWarranties.voidedAt} IS NULL
          AND ${orderItemWarranties.expiresAt} > CAST(strftime('%s','now') AS INTEGER)
      )`, WARRANTY_INACTIVE_GUARD);
}

/**
 * Opens a claim: the thread (unless reserved by an image upload), the claim,
 * the opening event and the description as the first public message, in one
 * batch. Replaying the same client key returns the claim it created.
 */
export async function openWarrantyClaim(
  db: Database,
  input: OpenClaimInput,
  options: { queue?: NotificationQueue; now?: number } = {},
): Promise<OpenClaimResult> {
  const clientKey = normalizeClientKey(input.clientKey);
  const body = normalizeConversationBody(input.description);
  if (!body.ok) {
    throw new ValidationError(body.reason === "too_long"
      ? `Keep the description under ${CONVERSATION_LIMITS.bodyLength.toLocaleString("en-US")} characters.`
      : body.reason === "invalid_characters"
        ? "The description contains characters that can't be sent."
        : "Describe the problem with the item.", { field: "description" });
  }
  const warranty = await accessibleWarranty(db, input.actor, input.warrantyId);
  if (input.orderId && input.orderId !== warranty.orderId) throw new NotFoundError("Warranty not found");
  const claimId = await claimIdFor(warranty.id, clientKey);
  const replay = await replayClaim(db, claimId, warranty);
  if (replay) return replay;

  const now = options.now ?? nowSeconds();
  assertClaimable(input.actor, warranty, now);
  const quantity = input.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > warranty.quantity) {
    throw new ValidationError(`Claim 1 to ${warranty.quantity} of this item.`, { field: "quantity" });
  }
  const open = await openClaimOn(db, warranty.id);
  if (open) throw claimAlreadyOpen(open.conversationId);

  const staff = input.actor.kind === "staff";
  const attachmentIds = input.attachmentIds ?? [];
  const expired = warranty.expiresAt <= now;

  for (let attempt = 1; attempt <= APPEND_ATTEMPTS; attempt += 1) {
    const reserved = await reservedThread(db, claimId);
    if (reserved && reserved.orderId !== warranty.orderId) throw new NotFoundError("Warranty not found");
    await assertStagedAttachments(db, reserved?.id ?? null, input.actor, attachmentIds);
    const threadId = reserved?.id ?? `cnv_${nanoid(20)}`;
    const lines: ConversationLine[] = [
      {
        kind: "event",
        visibility: "public",
        authorType: "system",
        eventKind: "warranty_claim_opened",
        eventData: { status: "open", claimId, warrantyId: warranty.id },
        body: claimOpenedLine(warranty, expired),
      },
      {
        kind: "message",
        visibility: "public",
        authorType: input.actor.kind,
        authorCustomerId: input.actor.kind === "customer" ? input.actor.customerId : null,
        authorUserId: input.actor.kind === "staff" ? input.actor.userId : null,
        body: body.value,
        clientMessageKey: `warranty-claim:${clientKey}`,
        attachmentIds,
        readBy: [staff ? "staff" : "customer"],
      },
    ];
    const plan = planConversationAppend(db, { id: threadId, lastSeq: reserved?.lastSeq ?? 0 }, lines, { notify: true });
    const statements: BatchStatement[] = [activeWarrantyGuard(db, warranty.id, staff) as unknown as BatchStatement];
    if (!reserved) {
      statements.push(db.insert(conversations).values({
        id: threadId,
        subjectType: "warranty_claim",
        subjectId: claimId,
        orderId: warranty.orderId,
        subject: claimSubject(warranty),
        status: "open",
        createdAt: now,
        updatedAt: now,
      }) as unknown as BatchStatement);
    }
    statements.push(db.insert(warrantyClaims).values({
      id: claimId,
      warrantyId: warranty.id,
      orderId: warranty.orderId,
      orderItemId: warranty.orderItemId,
      conversationId: threadId,
      status: "open",
      quantity,
      openedBy: openerFor(input.actor),
      version: 1,
      createdAt: now,
      updatedAt: now,
    }) as unknown as BatchStatement);
    statements.push(...plan.statements as unknown as BatchStatement[]);

    try {
      await safeBatch(db, statements as unknown as readonly BatchStatement[]);
      await enqueueConversationNotifications(db, options.queue, plan.outboxIds);
      return { claimId, conversationId: threadId, orderId: warranty.orderId, status: "open", created: true };
    } catch (error) {
      if (isBatchGuardError(error, WARRANTY_INACTIVE_GUARD)) {
        const fresh = await readClaimableWarranty(db, warranty.id);
        if (fresh && fresh.voidedAt === null && !staff) throw warrantyExpired(fresh.expiresAt);
        throw warrantyNotActive();
      }
      const text = errorText(error);
      const again = await replayClaim(db, claimId, warranty);
      if (again) return again;
      if (/warranty_claims_open_unique|warranty_claims\.warranty_id/i.test(text)) {
        throw claimAlreadyOpen((await openClaimOn(db, warranty.id))?.conversationId ?? null);
      }
      // A concurrent image upload reserved the thread, or a post raced the sequence: re-read and retry.
      if (attempt < APPEND_ATTEMPTS && /constraint|unique|conversation sequence|message seq|duplicate key/i.test(text)) continue;
      throw error;
    }
  }
  throw new ConflictError("The claim could not be sent. Please try again.");
}

// ─────────────────────────────────────────
// Staff status changes
// ─────────────────────────────────────────

export interface UpdateClaimInput {
  version: number;
  status: WarrantyClaimStatus;
  /** Required to resolve; ignored otherwise. */
  resolution?: WarrantyClaimResolution | null;
  /** An optional public reply to the buyer, posted with the status line (it notifies them). */
  message?: string | null;
  staffUserId: string;
  requestKey?: string | null;
}

/**
 * Moves a claim (open, in progress, resolved with a resolution, declined, or
 * reopened) against the version staff loaded, and writes the status event
 * line (plus an optional public reply) in the same batch. A reopen needs the
 * warranty's open-claim slot to be free.
 */
export async function updateWarrantyClaim(
  db: Database,
  claimId: string,
  input: UpdateClaimInput,
  options: { queue?: NotificationQueue } = {},
): Promise<StaffWarrantyClaim> {
  if (!isWarrantyClaimStatus(input.status)) throw new ValidationError("Choose a claim status.", { field: "status" });
  const resolution = input.status === "resolved" ? input.resolution ?? null : null;
  if (input.status === "resolved" && !isWarrantyClaimResolution(resolution)) {
    throw new ValidationError(`Choose how it was resolved: ${WARRANTY_CLAIM_RESOLUTIONS.join(", ")}.`, { field: "resolution" });
  }
  let message: string | null = null;
  if (typeof input.message === "string" && input.message.trim()) {
    const body = normalizeConversationBody(input.message);
    if (!body.ok) {
      throw new ValidationError(body.reason === "too_long"
        ? `Messages can be up to ${CONVERSATION_LIMITS.bodyLength} characters.`
        : "The message contains characters that can't be sent.", { field: "message" });
    }
    message = body.value;
  }

  const claim = await db.select().from(warrantyClaims).where(eq(warrantyClaims.id, claimId)).get();
  if (!claim) throw new NotFoundError("Claim not found");
  if (claim.version !== input.version) throw staleClaim();
  if (claim.status === input.status && (claim.resolution ?? null) === resolution && !message) {
    return getWarrantyClaim(db, claimId);
  }
  const closing = input.status === "resolved" || input.status === "rejected";
  const now = nowSeconds();
  const changed = claim.status !== input.status || (claim.resolution ?? null) !== resolution;

  for (let attempt = 1; attempt <= APPEND_ATTEMPTS; attempt += 1) {
    const thread = await readThread(db, claim.conversationId);
    if (!thread) throw new NotFoundError("Claim not found");
    const lines: ConversationLine[] = [];
    if (changed) {
      lines.push({
        kind: "event",
        visibility: "public",
        authorType: "system",
        eventKind: "warranty_claim_status",
        eventData: { fromStatus: claim.status, toStatus: input.status, ...(resolution ? { resolution } : {}), claimId },
        body: claimStatusLine(input.status, resolution),
        readBy: ["staff"],
      });
    }
    if (message) {
      lines.push({
        kind: "message",
        visibility: "public",
        authorType: "staff",
        authorUserId: input.staffUserId,
        body: message,
        clientMessageKey: input.requestKey ? `warranty-claim-status:${input.requestKey}` : null,
        readBy: ["staff"],
      });
    }
    const plan = planConversationAppend(db, thread, lines, { notify: true });
    try {
      await safeBatch(db, [
        buildBatchGuard(db, sql`EXISTS (
          SELECT 1 FROM ${warrantyClaims} WHERE ${warrantyClaims.id} = ${claimId} AND ${warrantyClaims.version} = ${input.version}
        )`, CLAIM_VERSION_GUARD),
        db.update(warrantyClaims).set({
          status: input.status,
          resolution,
          closedAt: closing ? (claim.closedAt ?? now) : null,
          version: sql`${warrantyClaims.version} + 1`,
          updatedAt: now,
        }).where(and(eq(warrantyClaims.id, claimId), eq(warrantyClaims.version, input.version))),
        ...plan.statements,
      ] as unknown as readonly BatchStatement[]);
      await enqueueConversationNotifications(db, options.queue, plan.outboxIds);
      return getWarrantyClaim(db, claimId);
    } catch (error) {
      if (isBatchGuardError(error, CLAIM_VERSION_GUARD)) throw staleClaim();
      const text = errorText(error);
      if (/warranty_claims_open_unique|warranty_claims\.warranty_id/i.test(text)) {
        throw new ConflictError("Another claim for this item is open. Close it before reopening this one.");
      }
      if (/client_message_key|conversation_messages_client_key_unique/i.test(text)) return getWarrantyClaim(db, claimId);
      if (attempt < APPEND_ATTEMPTS && /constraint|unique|conversation sequence|message seq|duplicate key/i.test(text)) continue;
      throw error;
    }
  }
  throw new ConflictError("The claim changed while you were saving. Please try again.");
}

// ─────────────────────────────────────────
// Staff reads
// ─────────────────────────────────────────

export interface StaffWarrantyClaim {
  id: string;
  status: WarrantyClaimStatus;
  resolution: WarrantyClaimResolution | null;
  quantity: number;
  openedBy: WarrantyClaimOpener;
  version: number;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  conversationId: string;
  order: { id: string; orderNumber: string };
  item: { id: string; productId: string | null; productName: string | null; variantLabel: string | null; productSlug: string | null };
  warranty: {
    id: string;
    quantity: number;
    startsAt: number;
    expiresAt: number;
    replacementUntil: number | null;
    voidedAt: number | null;
  };
  policy: {
    policyId: string;
    revisionId: string;
    revision: number;
    name: string;
    provider: WarrantyProvider;
    durationValue: number;
    durationUnit: WarrantyDurationUnit;
    replacementDays: number | null;
    terms: string | null;
  };
}

function staffClaimQuery(db: Database) {
  return db
    .select({
      claim: warrantyClaims,
      orderNumber: orders.orderNumber,
      productId: orderItems.productId,
      productName: orderItems.productName,
      variantLabel: orderItems.variantLabel,
      productSlug: products.slug,
      warranty: {
        id: orderItemWarranties.id,
        quantity: orderItemWarranties.quantity,
        startsAt: orderItemWarranties.startsAt,
        expiresAt: orderItemWarranties.expiresAt,
        replacementUntil: orderItemWarranties.replacementUntil,
        voidedAt: orderItemWarranties.voidedAt,
      },
      policy: {
        policyId: warrantyPolicyRevisions.policyId,
        revisionId: warrantyPolicyRevisions.id,
        revision: warrantyPolicyRevisions.revision,
        name: warrantyPolicyRevisions.name,
        provider: warrantyPolicyRevisions.provider,
        durationValue: warrantyPolicyRevisions.durationValue,
        durationUnit: warrantyPolicyRevisions.durationUnit,
        replacementDays: warrantyPolicyRevisions.replacementDays,
        terms: warrantyPolicyRevisions.terms,
      },
    })
    .from(warrantyClaims)
    .innerJoin(orderItemWarranties, eq(orderItemWarranties.id, warrantyClaims.warrantyId))
    .innerJoin(warrantyPolicyRevisions, eq(warrantyPolicyRevisions.id, orderItemWarranties.revisionId))
    .innerJoin(orders, eq(orders.id, warrantyClaims.orderId))
    .innerJoin(orderItems, eq(orderItems.id, warrantyClaims.orderItemId))
    .leftJoin(products, eq(products.id, orderItems.productId));
}

type StaffClaimRow = Awaited<ReturnType<ReturnType<typeof staffClaimQuery>["all"]>>[number];

function presentStaffClaim(row: StaffClaimRow): StaffWarrantyClaim {
  const { claim } = row;
  return {
    id: claim.id,
    status: claim.status,
    resolution: claim.resolution ?? null,
    quantity: claim.quantity,
    openedBy: claim.openedBy,
    version: claim.version,
    createdAt: claim.createdAt,
    updatedAt: claim.updatedAt,
    closedAt: claim.closedAt ?? null,
    conversationId: claim.conversationId,
    order: { id: claim.orderId, orderNumber: formatOrderNumber(row.orderNumber, claim.orderId) },
    item: {
      id: claim.orderItemId,
      productId: row.productId ?? null,
      productName: row.productName ?? null,
      variantLabel: row.variantLabel ?? null,
      productSlug: row.productSlug ?? null,
    },
    warranty: row.warranty,
    policy: {
      ...row.policy,
      provider: row.policy.provider as WarrantyProvider,
      durationUnit: row.policy.durationUnit as WarrantyDurationUnit,
    },
  };
}

export async function getWarrantyClaim(db: Database, claimId: string): Promise<StaffWarrantyClaim> {
  const row = await staffClaimQuery(db).where(eq(warrantyClaims.id, claimId)).get();
  if (!row) throw new NotFoundError("Claim not found");
  return presentStaffClaim(row);
}

export interface ClaimCursor {
  createdAt: number;
  id: string;
}

function decodeClaimCursor(value: string | null | undefined): ClaimCursor | null {
  if (!value) return null;
  const match = /^(\d{1,12})\.(wcl_[A-Za-z0-9_-]{8,64})$/.exec(value);
  if (!match) throw new ValidationError("Invalid cursor");
  return { createdAt: Number(match[1]), id: match[2]! };
}

/** One keyset page (25) of claims, newest first; optionally one status or one order. */
export async function listWarrantyClaims(
  db: Database,
  filters: { status?: WarrantyClaimStatus; orderId?: string; cursor?: string | null } = {},
): Promise<{ items: StaffWarrantyClaim[]; nextCursor: string | null }> {
  const cursor = decodeClaimCursor(filters.cursor);
  const conditions: Array<SQL | undefined> = [];
  if (filters.status) conditions.push(eq(warrantyClaims.status, filters.status));
  if (filters.orderId) conditions.push(eq(warrantyClaims.orderId, filters.orderId));
  if (cursor) {
    conditions.push(or(
      lt(warrantyClaims.createdAt, cursor.createdAt),
      and(eq(warrantyClaims.createdAt, cursor.createdAt), lt(warrantyClaims.id, cursor.id)),
    ));
  }
  const rows = await staffClaimQuery(db)
    .where(and(...conditions))
    .orderBy(desc(warrantyClaims.createdAt), desc(warrantyClaims.id))
    .limit(CLAIM_LIST_PAGE + 1)
    .all();
  const page = rows.slice(0, CLAIM_LIST_PAGE);
  const last = page.at(-1)?.claim;
  return {
    items: page.map(presentStaffClaim),
    nextCursor: rows.length > CLAIM_LIST_PAGE && last ? `${last.createdAt}.${last.id}` : null,
  };
}
