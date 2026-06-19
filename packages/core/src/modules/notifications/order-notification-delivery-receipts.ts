import type { Database } from "@scalius/database/client";
import { orderNotificationDeliveryReceipts } from "@scalius/database/schema";
import { and, eq, inArray, lte, or, sql } from "drizzle-orm";
import type { OrderNotificationType } from "./notification-types";

export type OrderNotificationDeliveryChannel = "email" | "sms" | "whatsapp" | "push";

export type OrderNotificationDeliveryReceiptStatus =
  | "pending"
  | "processing"
  | "accepted"
  | "delivered"
  | "failed"
  | "skipped";

export interface OrderNotificationDeliveryTargetInput {
  outboxId: string;
  orderId: string;
  notificationType: OrderNotificationType;
  channel: OrderNotificationDeliveryChannel;
  provider: string;
  recipient: string;
  recipientMasked?: string | null;
}

export interface OrderNotificationDeliveryTarget extends OrderNotificationDeliveryTargetInput {
  receiptKey: string;
  recipientHash: string;
  recipientMasked: string;
}

export interface OrderNotificationDeliveryReceiptClaim {
  id: string;
  receiptKey: string;
  claimId: string;
  attempts: number;
}

export interface OrderNotificationDeliveryReceiptResult {
  provider?: string;
  providerMessageId?: string | null;
  providerStatus?: string | null;
  rawResponse?: string | null;
}

type DeliveryReceiptRow = typeof orderNotificationDeliveryReceipts.$inferSelect;
type DeliveryReceiptInsert = typeof orderNotificationDeliveryReceipts.$inferInsert;

const PROCESSING_LEASE_SECONDS = 15 * 60;
const MAX_ERROR_LENGTH = 500;
const MAX_RAW_RESPONSE_LENGTH = 1000;
const TERMINAL_STATUSES = new Set<OrderNotificationDeliveryReceiptStatus>([
  "accepted",
  "delivered",
  "skipped",
]);

export async function createOrderNotificationDeliveryTarget(
  input: OrderNotificationDeliveryTargetInput,
): Promise<OrderNotificationDeliveryTarget> {
  const recipientHash = await hashNotificationRecipient(input.recipient);
  return {
    ...input,
    recipientHash,
    recipientMasked: input.recipientMasked ?? maskNotificationRecipient(input.recipient),
    receiptKey: buildOrderNotificationDeliveryReceiptKey({
      outboxId: input.outboxId,
      channel: input.channel,
      recipientHash,
    }),
  };
}

export function buildOrderNotificationDeliveryReceiptKey(options: {
  outboxId: string;
  channel: OrderNotificationDeliveryChannel;
  recipientHash: string;
}): string {
  return `${options.outboxId}:${options.channel}:${options.recipientHash}`;
}

export function createProviderClientReference(target: Pick<OrderNotificationDeliveryTarget, "outboxId" | "channel" | "recipientHash">): string {
  return `${target.outboxId}${target.channel}${target.recipientHash}`
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 20);
}

export async function claimOrderNotificationDeliveryReceipt(
  db: Database,
  target: OrderNotificationDeliveryTarget,
): Promise<
  | { claimed: true; receipt: OrderNotificationDeliveryReceiptClaim }
  | { claimed: false; reason: "accepted" | "delivered" | "skipped" | "busy" | "missing" }
> {
  await ensureOrderNotificationDeliveryReceipt(db, target);

  const claimId = createDeliveryReceiptClaimId();
  const rows = await db
    .update(orderNotificationDeliveryReceipts)
    .set({
      status: "processing",
      provider: target.provider,
      recipientMasked: target.recipientMasked,
      claimId,
      claimExpiresAt: sql`unixepoch() + ${PROCESSING_LEASE_SECONDS}`,
      attempts: sql`${orderNotificationDeliveryReceipts.attempts} + 1`,
      lastError: null,
      lastAttemptAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    })
    .where(
      and(
        eq(orderNotificationDeliveryReceipts.receiptKey, target.receiptKey),
        or(
          and(
            inArray(orderNotificationDeliveryReceipts.status, ["pending", "failed"]),
            lte(orderNotificationDeliveryReceipts.nextAttemptAt, sql`unixepoch()`),
          ),
          and(
            eq(orderNotificationDeliveryReceipts.status, "processing"),
            lte(orderNotificationDeliveryReceipts.claimExpiresAt, sql`unixepoch()`),
          ),
        ),
      ),
    )
    .returning({
      id: orderNotificationDeliveryReceipts.id,
      receiptKey: orderNotificationDeliveryReceipts.receiptKey,
      claimId: orderNotificationDeliveryReceipts.claimId,
      attempts: orderNotificationDeliveryReceipts.attempts,
    });

  const row = rows[0];
  if (row?.claimId) {
    return {
      claimed: true,
      receipt: {
        id: row.id,
        receiptKey: row.receiptKey,
        claimId: row.claimId,
        attempts: row.attempts,
      },
    };
  }

  const existing = await selectDeliveryReceiptByKey(db, target.receiptKey);
  if (!existing) return { claimed: false, reason: "missing" };
  if (TERMINAL_STATUSES.has(existing.status as OrderNotificationDeliveryReceiptStatus)) {
    return {
      claimed: false,
      reason: existing.status as "accepted" | "delivered" | "skipped",
    };
  }
  return { claimed: false, reason: "busy" };
}

export async function markOrderNotificationDeliveryReceiptAccepted(
  db: Database,
  receipt: OrderNotificationDeliveryReceiptClaim,
  result: OrderNotificationDeliveryReceiptResult = {},
): Promise<void> {
  await db
    .update(orderNotificationDeliveryReceipts)
    .set({
      status: "accepted",
      provider: result.provider ?? undefined,
      providerMessageId: result.providerMessageId ?? null,
      providerStatus: result.providerStatus ?? "accepted",
      rawResponse: normalizeRawResponse(result.rawResponse),
      claimId: null,
      claimExpiresAt: null,
      lastError: null,
      acceptedAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    })
    .where(and(
      eq(orderNotificationDeliveryReceipts.id, receipt.id),
      eq(orderNotificationDeliveryReceipts.claimId, receipt.claimId),
    ));
}

export async function markOrderNotificationDeliveryReceiptSkipped(
  db: Database,
  receipt: OrderNotificationDeliveryReceiptClaim,
  reason: string,
  result: OrderNotificationDeliveryReceiptResult = {},
): Promise<void> {
  await db
    .update(orderNotificationDeliveryReceipts)
    .set({
      status: "skipped",
      provider: result.provider ?? undefined,
      providerMessageId: result.providerMessageId ?? null,
      providerStatus: normalizeRawResponse(result.providerStatus ?? reason),
      rawResponse: normalizeRawResponse(result.rawResponse),
      claimId: null,
      claimExpiresAt: null,
      lastError: normalizeError(reason),
      skippedAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    })
    .where(and(
      eq(orderNotificationDeliveryReceipts.id, receipt.id),
      eq(orderNotificationDeliveryReceipts.claimId, receipt.claimId),
    ));
}

export async function markOrderNotificationDeliveryReceiptFailed(
  db: Database,
  receipt: OrderNotificationDeliveryReceiptClaim,
  error: unknown,
  result: OrderNotificationDeliveryReceiptResult = {},
): Promise<void> {
  await db
    .update(orderNotificationDeliveryReceipts)
    .set({
      status: "failed",
      provider: result.provider ?? undefined,
      providerMessageId: result.providerMessageId ?? null,
      providerStatus: normalizeRawResponse(result.providerStatus),
      rawResponse: normalizeRawResponse(result.rawResponse),
      claimId: null,
      claimExpiresAt: null,
      lastError: normalizeError(error),
      nextAttemptAt: sql`unixepoch() + ${getRetryDelaySeconds(receipt.attempts)}`,
      failedAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    })
    .where(and(
      eq(orderNotificationDeliveryReceipts.id, receipt.id),
      eq(orderNotificationDeliveryReceipts.claimId, receipt.claimId),
    ));
}

async function ensureOrderNotificationDeliveryReceipt(
  db: Database,
  target: OrderNotificationDeliveryTarget,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const dueNow = Math.max(0, now - 1);
  const values: DeliveryReceiptInsert = {
    id: createDeliveryReceiptId(),
    receiptKey: target.receiptKey,
    outboxId: target.outboxId,
    orderId: target.orderId,
    notificationType: target.notificationType,
    channel: target.channel,
    provider: target.provider,
    recipientHash: target.recipientHash,
    recipientMasked: target.recipientMasked,
    status: "pending",
    attempts: 0,
    nextAttemptAt: dueNow,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await db.insert(orderNotificationDeliveryReceipts).values(values);
  } catch (error) {
    const existing = await selectDeliveryReceiptByKey(db, target.receiptKey);
    if (!existing) throw error;
  }
}

async function selectDeliveryReceiptByKey(
  db: Database,
  receiptKey: string,
): Promise<DeliveryReceiptRow | undefined> {
  return await db
    .select()
    .from(orderNotificationDeliveryReceipts)
    .where(eq(orderNotificationDeliveryReceipts.receiptKey, receiptKey))
    .get();
}

async function hashNotificationRecipient(recipient: string): Promise<string> {
  const normalized = recipient.trim().toLowerCase();
  const encoder = new TextEncoder();

  if (typeof crypto !== "undefined" && crypto.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(normalized));
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  return fallbackHash(normalized);
}

function fallbackHash(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return `fallback${(hash >>> 0).toString(16).padStart(8, "0")}`.padEnd(64, "0");
}

function maskNotificationRecipient(recipient: string): string {
  const trimmed = recipient.trim();
  if (!trimmed) return "missing";

  if (trimmed.includes("@")) {
    const [local = "", domain = ""] = trimmed.split("@");
    const first = local.slice(0, 1) || "*";
    return `${first}***@${domain}`;
  }

  if (trimmed.length <= 4) {
    return "****";
  }

  return `***${trimmed.slice(-4)}`;
}

function createDeliveryReceiptId(): string {
  return `ond_${createRandomId()}`;
}

function createDeliveryReceiptClaimId(): string {
  return `ondc_${createRandomId()}`;
}

function createRandomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return `${Date.now().toString(36)}${fallbackHash(String(Date.now())).slice(0, 12)}`;
}

function normalizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
}

function normalizeRawResponse(value: string | null | undefined): string | null {
  if (value == null) return null;
  return String(value).slice(0, MAX_RAW_RESPONSE_LENGTH);
}

function getRetryDelaySeconds(attempts: number): number {
  const normalizedAttempts = Math.max(1, Math.min(attempts, 8));
  return Math.min(60 * 60, 60 * 2 ** (normalizedAttempts - 1));
}
