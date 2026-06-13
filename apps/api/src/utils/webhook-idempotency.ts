import { and, eq, lte, sql } from "drizzle-orm";
import { webhookEvents } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";

export type WebhookEventStatus = "processing" | "queued" | "processed" | "failed";
export const DEFAULT_WEBHOOK_PROCESSING_LEASE_SECONDS = 5 * 60;

export interface WebhookEventClaim {
  id: string;
  provider: string;
  eventType: string;
  orderId?: string | null;
  status?: WebhookEventStatus;
  result?: unknown;
}

export interface WebhookEventClaimResult {
  claimed: boolean;
  retryingFailedEvent?: boolean;
  reclaimingStaleProcessingEvent?: boolean;
  existing?: {
    id: string;
    provider: string;
    eventType: string;
    orderId: string | null;
    status: string;
    result: string | null;
    processedAt: Date | number | string | null;
  } | null;
}

export interface WebhookEventClaimOptions {
  processingLeaseSeconds?: number;
}

function serializeResult(result: unknown): string | null {
  if (result === undefined || result === null) return null;
  if (typeof result === "string") return result;
  return JSON.stringify(result);
}

export function buildWebhookEventId(
  provider: string,
  eventType: string,
  sourceEventId: string,
): string {
  return `${provider}:${eventType}:${sourceEventId}`
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function claimWebhookEvent(
  db: Database,
  claim: WebhookEventClaim,
  options: WebhookEventClaimOptions = {},
): Promise<WebhookEventClaimResult> {
  const status = claim.status ?? "processing";
  const processingLeaseSeconds = options.processingLeaseSeconds ?? DEFAULT_WEBHOOK_PROCESSING_LEASE_SECONDS;

  try {
    await db.insert(webhookEvents).values({
      id: claim.id,
      provider: claim.provider,
      eventType: claim.eventType,
      orderId: claim.orderId ?? null,
      status,
      result: serializeResult(claim.result),
      processedAt: sql`unixepoch()`,
    });

    return { claimed: true };
  } catch (insertError) {
    const existing = await db
      .select({
        id: webhookEvents.id,
        provider: webhookEvents.provider,
        eventType: webhookEvents.eventType,
        orderId: webhookEvents.orderId,
        status: webhookEvents.status,
        result: webhookEvents.result,
        processedAt: webhookEvents.processedAt,
      })
      .from(webhookEvents)
      .where(eq(webhookEvents.id, claim.id))
      .get();

    if (!existing) throw insertError;

    if (existing?.status === "failed") {
      const reclaimed = await db
        .update(webhookEvents)
        .set({
          status,
          orderId: claim.orderId ?? existing.orderId,
          result: serializeResult(claim.result),
          processedAt: sql`unixepoch()`,
        })
        .where(and(
          eq(webhookEvents.id, claim.id),
          eq(webhookEvents.status, "failed"),
        ))
        .returning({ id: webhookEvents.id });

      if (reclaimed.length > 0) {
        return { claimed: true, retryingFailedEvent: true, existing };
      }

      return { claimed: false, existing };
    }

    if (existing?.status === "processing") {
      const reclaimed = await db
        .update(webhookEvents)
        .set({
          status,
          orderId: claim.orderId ?? existing.orderId,
          result: serializeResult(claim.result),
          processedAt: sql`unixepoch()`,
        })
        .where(and(
          eq(webhookEvents.id, claim.id),
          eq(webhookEvents.status, "processing"),
          lte(webhookEvents.processedAt, sql`unixepoch() - ${processingLeaseSeconds}`),
        ))
        .returning({ id: webhookEvents.id });

      if (reclaimed.length > 0) {
        return { claimed: true, reclaimingStaleProcessingEvent: true, existing };
      }
    }

    return { claimed: false, existing: existing ?? null };
  }
}

export async function markWebhookEventQueued(
  db: Database,
  id: string,
  result?: unknown,
): Promise<void> {
  await markWebhookEvent(db, id, "queued", result);
}

export async function markWebhookEventProcessed(
  db: Database,
  id: string,
  result?: unknown,
): Promise<void> {
  await markWebhookEvent(db, id, "processed", result);
}

export async function markWebhookEventFailed(
  db: Database,
  id: string,
  result?: unknown,
): Promise<void> {
  await markWebhookEvent(db, id, "failed", result);
}

async function markWebhookEvent(
  db: Database,
  id: string,
  status: WebhookEventStatus,
  result?: unknown,
): Promise<void> {
  await db
    .update(webhookEvents)
    .set({
      status,
      result: serializeResult(result),
      processedAt: sql`unixepoch()`,
    })
    .where(eq(webhookEvents.id, id));
}
