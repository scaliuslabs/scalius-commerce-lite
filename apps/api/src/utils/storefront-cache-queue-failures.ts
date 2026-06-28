import type { Database } from "@scalius/database/client";
import { storefrontCacheQueueFailures } from "@scalius/database/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from "./api-error";
import type { StorefrontCacheQueueMessage } from "./cache-invalidation";

export type StorefrontCacheQueueFailureStatus = "pending" | "replayed" | "ignored";

export interface StorefrontCacheQueueFailureRecord {
  id: string;
  queueName: string;
  queueMessageId: string;
  messageType: string;
  operationId: string | null;
  source: string | null;
  attempts: number;
  status: StorefrontCacheQueueFailureStatus;
  lastError: string | null;
  replayCount: number;
  messageTimestamp: number | null;
  failedAt: number;
  replayedAt: number | null;
  replayedBy: string | null;
  ignoredAt: number | null;
  ignoredBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface StorefrontCacheQueueFailureDetail extends StorefrontCacheQueueFailureRecord {
  payload: StorefrontCacheQueueMessage;
}

type StorefrontCacheQueue = Pick<Queue<StorefrontCacheQueueMessage>, "send">;

const FAILURE_ID_PREFIX = "scqf_";

function createFailureId(): string {
  return `${FAILURE_ID_PREFIX}${crypto.randomUUID()}`;
}

function toUnixSeconds(date: Date | string | number | undefined): number | null {
  if (!date) return null;
  const parsed = date instanceof Date ? date : new Date(date);
  const time = parsed.getTime();
  return Number.isFinite(time) ? Math.floor(time / 1000) : null;
}

function isStorefrontCacheQueueMessage(value: unknown): value is StorefrontCacheQueueMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StorefrontCacheQueueMessage>;
  if (candidate.type === "storefront.cache_purge") {
    return (
      typeof candidate.operationId === "string" &&
      Array.isArray(candidate.groups) &&
      Array.isArray(candidate.prefixes) &&
      typeof candidate.bumpVersion === "boolean" &&
      typeof candidate.source === "string" &&
      typeof candidate.requestedAt === "number"
    );
  }

  if (candidate.type === "storefront.cache_warm") {
    return (
      typeof candidate.operationId === "string" &&
      Array.isArray(candidate.paths) &&
      typeof candidate.source === "string" &&
      typeof candidate.requestedAt === "number"
    );
  }

  return false;
}

function parsePayload(payload: string): StorefrontCacheQueueMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new ValidationError("Stored storefront cache queue payload is unreadable.");
  }

  if (!isStorefrontCacheQueueMessage(parsed)) {
    throw new ValidationError("Stored storefront cache queue payload is not replayable.");
  }

  return parsed;
}

function normalizeFailureStatus(value: string): StorefrontCacheQueueFailureStatus {
  if (value === "pending" || value === "replayed" || value === "ignored") {
    return value;
  }
  throw new ValidationError("Stored storefront cache queue failure status is invalid.");
}

function rowToRecord(row: typeof storefrontCacheQueueFailures.$inferSelect): StorefrontCacheQueueFailureRecord {
  return {
    id: row.id,
    queueName: row.queueName,
    queueMessageId: row.queueMessageId,
    messageType: row.messageType,
    operationId: row.operationId,
    source: row.source,
    attempts: row.attempts,
    status: normalizeFailureStatus(row.status),
    lastError: row.lastError,
    replayCount: row.replayCount,
    messageTimestamp: row.messageTimestamp,
    failedAt: row.failedAt,
    replayedAt: row.replayedAt,
    replayedBy: row.replayedBy,
    ignoredAt: row.ignoredAt,
    ignoredBy: row.ignoredBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToDetail(row: typeof storefrontCacheQueueFailures.$inferSelect): StorefrontCacheQueueFailureDetail {
  return {
    ...rowToRecord(row),
    payload: parsePayload(row.payload),
  };
}

export async function archiveStorefrontCacheQueueFailure(
  db: Database,
  message: Message<StorefrontCacheQueueMessage>,
  queueName = "storefront-cache-dlq",
): Promise<StorefrontCacheQueueFailureRecord> {
  const payload = message.body;
  const payloadJson = JSON.stringify(payload);
  const messageTimestamp = toUnixSeconds(message.timestamp);
  const values = {
    id: createFailureId(),
    queueName,
    queueMessageId: message.id,
    messageType: payload.type,
    operationId: payload.operationId,
    source: payload.source,
    payload: payloadJson,
    attempts: message.attempts,
    status: "pending",
    lastError: null,
    replayCount: 0,
    messageTimestamp,
    failedAt: sql`unixepoch()`,
    replayedAt: null,
    replayedBy: null,
    ignoredAt: null,
    ignoredBy: null,
    createdAt: sql`unixepoch()`,
    updatedAt: sql`unixepoch()`,
  };

  const rows = await db
    .insert(storefrontCacheQueueFailures)
    .values(values)
    .onConflictDoUpdate({
      target: storefrontCacheQueueFailures.queueMessageId,
      set: {
        queueName,
        messageType: payload.type,
        operationId: payload.operationId,
        source: payload.source,
        payload: payloadJson,
        attempts: message.attempts,
        status: "pending",
        lastError: null,
        messageTimestamp,
        failedAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      },
    })
    .returning();

  const row = rows[0];
  if (!row) {
    throw new ServiceUnavailableError("Failed to archive storefront cache DLQ evidence.");
  }
  return rowToRecord(row);
}

export async function listStorefrontCacheQueueFailures(
  db: Database,
  options: {
    status?: StorefrontCacheQueueFailureStatus;
    limit?: number;
  } = {},
): Promise<StorefrontCacheQueueFailureRecord[]> {
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 25), 1), 100);
  const where = options.status
    ? eq(storefrontCacheQueueFailures.status, options.status)
    : undefined;

  const rows = await db
    .select()
    .from(storefrontCacheQueueFailures)
    .where(where)
    .orderBy(desc(storefrontCacheQueueFailures.failedAt))
    .limit(limit);

  return rows.map(rowToRecord);
}

export async function getStorefrontCacheQueueFailure(
  db: Database,
  id: string,
): Promise<StorefrontCacheQueueFailureDetail> {
  const row = await db
    .select()
    .from(storefrontCacheQueueFailures)
    .where(eq(storefrontCacheQueueFailures.id, id))
    .get();

  if (!row) {
    throw new NotFoundError("Storefront cache queue failure was not found.");
  }
  return rowToDetail(row);
}

export async function replayStorefrontCacheQueueFailure(
  db: Database,
  id: string,
  queue: StorefrontCacheQueue | undefined,
  replayedBy: string | null,
): Promise<StorefrontCacheQueueFailureDetail> {
  if (typeof queue?.send !== "function") {
    throw new ServiceUnavailableError("Storefront cache queue binding is unavailable.");
  }

  const failure = await getStorefrontCacheQueueFailure(db, id);
  if (failure.status === "ignored") {
    throw new ConflictError("Ignored storefront cache queue failures cannot be replayed.");
  }

  await queue.send(failure.payload);

  const rows = await db
    .update(storefrontCacheQueueFailures)
    .set({
      status: "replayed",
      replayCount: sql`${storefrontCacheQueueFailures.replayCount} + 1`,
      replayedAt: sql`unixepoch()`,
      replayedBy,
      updatedAt: sql`unixepoch()`,
    })
    .where(eq(storefrontCacheQueueFailures.id, id))
    .returning();

  const row = rows[0];
  if (!row) {
    throw new ServiceUnavailableError("Storefront cache queue failure replay was enqueued but not recorded.");
  }

  return rowToDetail(row);
}

export async function ignoreStorefrontCacheQueueFailure(
  db: Database,
  id: string,
  ignoredBy: string | null,
): Promise<StorefrontCacheQueueFailureRecord> {
  const rows = await db
    .update(storefrontCacheQueueFailures)
    .set({
      status: "ignored",
      ignoredAt: sql`unixepoch()`,
      ignoredBy,
      updatedAt: sql`unixepoch()`,
    })
    .where(and(
      eq(storefrontCacheQueueFailures.id, id),
      eq(storefrontCacheQueueFailures.status, "pending"),
    ))
    .returning();

  const row = rows[0];
  if (!row) {
    throw new ConflictError("Only pending storefront cache queue failures can be ignored.");
  }

  return rowToRecord(row);
}
