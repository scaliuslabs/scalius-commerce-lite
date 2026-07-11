import type { Database } from "@scalius/database/client";
import {
    metaCapiPurchaseOutbox,
    orderItems,
    orders,
    PaymentMethod,
    PaymentStatus,
    OrderStatus,
} from "@scalius/database/schema";
import { and, asc, eq, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import { getCurrencyConfig } from "../../modules/settings/settings.service";
import { sendCapiEvent, type SendCapiEventResult } from "./conversions-api";

type PurchaseOutboxRow = typeof metaCapiPurchaseOutbox.$inferSelect;
type PurchaseOutboxInsert = typeof metaCapiPurchaseOutbox.$inferInsert;
type SQLiteBatchItem = BatchItem<"sqlite">;
type PurchaseOrder = Pick<
    typeof orders.$inferSelect,
    | "id"
    | "customerId"
    | "customerName"
    | "customerPhone"
    | "customerEmail"
    | "city"
    | "cityName"
    | "totalAmount"
    | "status"
    | "paymentMethod"
    | "paymentStatus"
    | "paidAmount"
    | "deletedAt"
>;
type PurchaseOrderItem = Pick<
    typeof orderItems.$inferSelect,
    "productId" | "variantId" | "quantity" | "price"
>;

export type MetaCapiPurchaseOutboxStatus =
    | "pending"
    | "processing"
    | "sent"
    | "failed"
    | "skipped";

interface MetaPurchaseRuntimeOptions {
    storefrontUrl?: string | null;
    encryptionKey?: string;
    source: string;
}

interface BuildMetaPurchaseEventOptions {
    order: PurchaseOrder;
    items: PurchaseOrderItem[];
    storefrontUrl: string;
    currency: string;
    eventTime?: number;
}

interface ProcessMetaPurchaseOptions {
    storefrontUrl?: string | null;
    encryptionKey?: string;
}

export interface MetaPurchaseOutboxClaimInput {
    orderId: string;
    source: string;
    nowSeconds?: number;
}

export interface MetaPurchaseOutboxClaimBatchInput extends MetaPurchaseOutboxClaimInput {
    onlyIf?: SQL;
}

const PROCESSING_LEASE_SECONDS = 5 * 60;
const MAX_FLUSH_LIMIT = 25;
const MAX_ERROR_LENGTH = 500;

export function createMetaPurchaseEventId(orderId: string): string {
    return `Purchase:${orderId}`;
}

export function isOrderEligibleForMetaPurchase(order: PurchaseOrder): boolean {
    if (order.deletedAt) return false;
    if (
        order.status === OrderStatus.INCOMPLETE ||
        order.status === OrderStatus.CANCELLED ||
        order.status === OrderStatus.REFUNDED ||
        order.status === OrderStatus.RETURNED
    ) {
        return false;
    }

    if (order.paymentMethod === PaymentMethod.COD) {
        return true;
    }

    return (
        order.paymentStatus === PaymentStatus.PAID ||
        order.paymentStatus === PaymentStatus.PARTIAL ||
        Number(order.paidAmount) > 0
    );
}

export function buildMetaPurchaseEvent(options: BuildMetaPurchaseEventOptions) {
    const { order, items, currency } = options;
    const contentIds = items.map((item) => item.variantId || item.productId);
    const userData: Record<string, unknown> = {
        ph: order.customerPhone,
        country: "bd",
    };

    if (order.customerEmail) userData.em = order.customerEmail;
    if (order.customerId) userData.external_id = [order.customerId];

    const [firstName, lastName] = splitCustomerName(order.customerName);
    if (firstName) userData.fn = firstName;
    if (lastName) userData.ln = lastName;

    const city = order.cityName || order.city;
    if (city) userData.ct = city;

    return {
        event_name: "Purchase",
        event_time: options.eventTime ?? Math.floor(Date.now() / 1000),
        event_source_url: createOrderSuccessEventSourceUrl(options.storefrontUrl, order.id),
        event_id: createMetaPurchaseEventId(order.id),
        action_source: "website" as const,
        user_data: userData,
        custom_data: {
            value: order.totalAmount,
            currency,
            content_ids: contentIds,
            contents: items.map((item) => ({
                id: item.variantId || item.productId,
                quantity: item.quantity,
                item_price: item.price,
                delivery_category: "home_delivery" as const,
            })),
            content_type: "product_group" as const,
            order_id: order.id,
            num_items: items.reduce((sum, item) => sum + item.quantity, 0),
        },
    };
}

export function createMetaPurchaseOutboxClaimInsertValues(
    input: MetaPurchaseOutboxClaimInput,
): PurchaseOutboxInsert {
    const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
    return {
        id: createOutboxId(),
        orderId: input.orderId,
        eventId: createMetaPurchaseEventId(input.orderId),
        source: input.source,
        status: "pending",
        attempts: 0,
        nextAttemptAt: Math.max(0, now - 1),
        createdAt: now,
        updatedAt: now,
    };
}

export function buildMetaPurchaseOutboxClaimInsert(
    db: Database,
    input: MetaPurchaseOutboxClaimBatchInput,
): SQLiteBatchItem {
    const values = createMetaPurchaseOutboxClaimInsertValues(input);
    if (input.onlyIf) {
        return db
            .insert(metaCapiPurchaseOutbox)
            .select(sql`
                SELECT
                    ${values.id},
                    ${values.orderId},
                    ${values.eventId},
                    ${values.source},
                    ${values.status},
                    ${values.attempts},
                    ${values.nextAttemptAt},
                    NULL,
                    NULL,
                    NULL,
                    NULL,
                    NULL,
                    ${values.createdAt},
                    ${values.updatedAt}
                WHERE ${input.onlyIf}
            `)
            .onConflictDoNothing() as SQLiteBatchItem;
    }

    return db
        .insert(metaCapiPurchaseOutbox)
        .values(values)
        .onConflictDoNothing() as SQLiteBatchItem;
}

export async function ensureAndProcessMetaPurchaseForOrder(options: {
    db: Database;
    orderId: string;
} & MetaPurchaseRuntimeOptions): Promise<{
    outboxId: string;
    created: boolean;
    processed: boolean;
    status: MetaCapiPurchaseOutboxStatus;
}> {
    const recorded = await recordMetaPurchaseOutbox(options.db, {
        orderId: options.orderId,
        source: options.source,
    });

    if (recorded.row.status === "sent" || recorded.row.status === "skipped") {
        return {
            outboxId: recorded.row.id,
            created: recorded.created,
            processed: false,
            status: recorded.row.status as MetaCapiPurchaseOutboxStatus,
        };
    }

    const result = await processMetaPurchaseOutboxById(options.db, recorded.row.id, {
        storefrontUrl: options.storefrontUrl,
        encryptionKey: options.encryptionKey,
    });

    return {
        outboxId: recorded.row.id,
        created: recorded.created,
        processed: result.processed,
        status: result.status,
    };
}

export async function processExistingMetaPurchaseOutboxForOrder(options: {
    db: Database;
    orderId: string;
} & MetaPurchaseRuntimeOptions): Promise<
    | {
        outboxId: string;
        missing: false;
        processed: boolean;
        status: MetaCapiPurchaseOutboxStatus;
    }
    | {
        outboxId: null;
        missing: true;
        processed: false;
        status: "missing";
    }
> {
    const row = await selectOutboxByOrderId(options.db, options.orderId);
    if (!row) {
        return {
            outboxId: null,
            missing: true,
            processed: false,
            status: "missing",
        };
    }

    if (row.status === "sent" || row.status === "skipped") {
        return {
            outboxId: row.id,
            missing: false,
            processed: false,
            status: row.status as MetaCapiPurchaseOutboxStatus,
        };
    }

    const result = await processMetaPurchaseOutboxById(options.db, row.id, {
        storefrontUrl: options.storefrontUrl,
        encryptionKey: options.encryptionKey,
    });

    return {
        outboxId: row.id,
        missing: false,
        processed: result.processed,
        status: result.status,
    };
}

export async function flushPendingMetaPurchaseOutbox(options: {
    db: Database;
    storefrontUrl?: string | null;
    encryptionKey?: string;
    limit?: number;
}): Promise<{ scanned: number; sent: number; failed: number; skipped: number; busy: number }> {
    const limit = Math.max(1, Math.min(options.limit ?? 10, MAX_FLUSH_LIMIT));
    const dueRows = await options.db
        .select({ id: metaCapiPurchaseOutbox.id })
        .from(metaCapiPurchaseOutbox)
        .where(
            or(
                and(
                    inArray(metaCapiPurchaseOutbox.status, ["pending", "failed"]),
                    lte(metaCapiPurchaseOutbox.nextAttemptAt, sql`unixepoch()`),
                ),
                and(
                    eq(metaCapiPurchaseOutbox.status, "processing"),
                    lte(metaCapiPurchaseOutbox.claimExpiresAt, sql`unixepoch()`),
                ),
            ),
        )
        .orderBy(asc(metaCapiPurchaseOutbox.nextAttemptAt), asc(metaCapiPurchaseOutbox.createdAt))
        .limit(limit)
        .all();

    let sent = 0;
    let failed = 0;
    let skipped = 0;
    let busy = 0;

    for (const row of dueRows) {
        const result = await processMetaPurchaseOutboxById(options.db, row.id, {
            storefrontUrl: options.storefrontUrl,
            encryptionKey: options.encryptionKey,
        });
        if (result.status === "sent") sent += 1;
        else if (result.status === "failed") failed += 1;
        else if (result.status === "skipped") skipped += 1;
        else busy += 1;
    }

    return { scanned: dueRows.length, sent, failed, skipped, busy };
}

async function recordMetaPurchaseOutbox(
    db: Database,
    input: { orderId: string; source: string },
): Promise<{ row: PurchaseOutboxRow; created: boolean }> {
    const values = createMetaPurchaseOutboxClaimInsertValues(input);

    try {
        await db.insert(metaCapiPurchaseOutbox).values(values);
        return { row: valuesToRow(values), created: true };
    } catch (error) {
        const existing = await selectOutboxByOrderId(db, input.orderId);
        if (!existing) throw error;

        if (existing.status === "pending" || existing.status === "failed") {
            await db
                .update(metaCapiPurchaseOutbox)
                .set({
                    source: input.source,
                    status: "pending",
                    nextAttemptAt: sql`unixepoch()`,
                    claimId: null,
                    claimExpiresAt: null,
                    lastError: null,
                    updatedAt: sql`unixepoch()`,
                })
                .where(and(
                    eq(metaCapiPurchaseOutbox.orderId, input.orderId),
                    inArray(metaCapiPurchaseOutbox.status, ["pending", "failed"]),
                ));
            const refreshed = await selectOutboxByOrderId(db, input.orderId);
            return { row: refreshed ?? existing, created: false };
        }

        return { row: existing, created: false };
    }
}

async function processMetaPurchaseOutboxById(
    db: Database,
    outboxId: string,
    options: ProcessMetaPurchaseOptions,
): Promise<{ processed: boolean; status: MetaCapiPurchaseOutboxStatus }> {
    const claim = await claimMetaPurchaseOutbox(db, outboxId);
    if (!claim.claimed) {
        return {
            processed: false,
            status: claim.reason === "already_sent" ? "sent" : "processing",
        };
    }

    try {
        const payload = await buildMetaPurchasePayloadForOutbox(db, claim.row, options.storefrontUrl);
        if (!payload.sendable) {
            await markMetaPurchaseOutboxSkipped(db, claim.row.id, claim.claimId, payload.reason);
            return { processed: true, status: "skipped" };
        }

        const result = await sendCapiEvent(db, payload.event, {
            encryptionKey: options.encryptionKey,
        });
        await markMetaPurchaseOutboxAfterSend(db, claim.row.id, claim.claimId, claim.row.attempts, result);
        return {
            processed: true,
            status: result.success ? "sent" : result.retryable === false ? "skipped" : "failed",
        };
    } catch (error) {
        await markMetaPurchaseOutboxFailed(
            db,
            claim.row.id,
            claim.claimId,
            claim.row.attempts,
            error,
        );
        return { processed: true, status: "failed" };
    }
}

async function buildMetaPurchasePayloadForOutbox(
    db: Database,
    outbox: Pick<PurchaseOutboxRow, "orderId">,
    storefrontUrl?: string | null,
): Promise<
    | { sendable: true; event: ReturnType<typeof buildMetaPurchaseEvent> }
    | { sendable: false; reason: string }
> {
    const baseUrl = normalizeStorefrontUrl(storefrontUrl);
    if (!baseUrl) {
        return { sendable: false, reason: "STOREFRONT_URL is not configured." };
    }

    const order = await db
        .select()
        .from(orders)
        .where(eq(orders.id, outbox.orderId))
        .get();
    if (!order) {
        return { sendable: false, reason: "Order no longer exists." };
    }
    if (!isOrderEligibleForMetaPurchase(order)) {
        return { sendable: false, reason: `Order is not eligible for Purchase CAPI in status ${order.status}/${order.paymentStatus}.` };
    }

    const items = await db
        .select()
        .from(orderItems)
        .where(eq(orderItems.orderId, outbox.orderId))
        .all();
    if (items.length === 0) {
        return { sendable: false, reason: "Order has no items." };
    }

    const currency = await getCurrencyConfig(db);
    return {
        sendable: true,
        event: buildMetaPurchaseEvent({
            order,
            items,
            storefrontUrl: baseUrl,
            currency: currency.code,
        }),
    };
}

async function claimMetaPurchaseOutbox(
    db: Database,
    outboxId: string,
): Promise<
    | { claimed: true; claimId: string; row: Pick<PurchaseOutboxRow, "id" | "orderId" | "attempts"> }
    | { claimed: false; reason: "already_sent" | "skipped" | "busy" | "missing" }
> {
    const claimId = createClaimId();
    const rows = await db
        .update(metaCapiPurchaseOutbox)
        .set({
            status: "processing",
            claimId,
            claimExpiresAt: sql`unixepoch() + ${PROCESSING_LEASE_SECONDS}`,
            attempts: sql`${metaCapiPurchaseOutbox.attempts} + 1`,
            lastError: null,
            updatedAt: sql`unixepoch()`,
        })
        .where(
            and(
                eq(metaCapiPurchaseOutbox.id, outboxId),
                or(
                    and(
                        inArray(metaCapiPurchaseOutbox.status, ["pending", "failed"]),
                        lte(metaCapiPurchaseOutbox.nextAttemptAt, sql`unixepoch()`),
                    ),
                    and(
                        eq(metaCapiPurchaseOutbox.status, "processing"),
                        lte(metaCapiPurchaseOutbox.claimExpiresAt, sql`unixepoch()`),
                    ),
                ),
            ),
        )
        .returning({
            id: metaCapiPurchaseOutbox.id,
            orderId: metaCapiPurchaseOutbox.orderId,
            attempts: metaCapiPurchaseOutbox.attempts,
        });

    const row = rows[0];
    if (row) return { claimed: true, claimId, row };

    const existing = await selectOutboxById(db, outboxId);
    if (!existing) return { claimed: false, reason: "missing" };
    if (existing.status === "sent") return { claimed: false, reason: "already_sent" };
    if (existing.status === "skipped") return { claimed: false, reason: "skipped" };
    return { claimed: false, reason: "busy" };
}

async function markMetaPurchaseOutboxAfterSend(
    db: Database,
    outboxId: string,
    claimId: string,
    attempts: number,
    result: SendCapiEventResult,
): Promise<void> {
    if (result.success) {
        await markMetaPurchaseOutboxSent(db, outboxId, claimId);
        return;
    }

    if (result.retryable === false) {
        await markMetaPurchaseOutboxSkipped(db, outboxId, claimId, result.error ?? "Meta CAPI event skipped.");
        return;
    }

    await markMetaPurchaseOutboxFailed(db, outboxId, claimId, attempts, result.error ?? "Meta CAPI send failed.");
}

async function markMetaPurchaseOutboxSent(db: Database, outboxId: string, claimId: string): Promise<void> {
    await db
        .update(metaCapiPurchaseOutbox)
        .set({
            status: "sent",
            claimId: null,
            claimExpiresAt: null,
            lastError: null,
            sentAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(metaCapiPurchaseOutbox.id, outboxId),
            eq(metaCapiPurchaseOutbox.claimId, claimId),
        ));
}

async function markMetaPurchaseOutboxSkipped(
    db: Database,
    outboxId: string,
    claimId: string,
    reason: string,
): Promise<void> {
    await db
        .update(metaCapiPurchaseOutbox)
        .set({
            status: "skipped",
            claimId: null,
            claimExpiresAt: null,
            lastError: normalizeError(reason),
            skippedAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(metaCapiPurchaseOutbox.id, outboxId),
            eq(metaCapiPurchaseOutbox.claimId, claimId),
        ));
}

async function markMetaPurchaseOutboxFailed(
    db: Database,
    outboxId: string,
    claimId: string,
    attempts: number,
    error: unknown,
): Promise<void> {
    await db
        .update(metaCapiPurchaseOutbox)
        .set({
            status: "failed",
            claimId: null,
            claimExpiresAt: null,
            lastError: normalizeError(error),
            nextAttemptAt: sql`unixepoch() + ${getRetryDelaySeconds(attempts)}`,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(metaCapiPurchaseOutbox.id, outboxId),
            eq(metaCapiPurchaseOutbox.claimId, claimId),
        ));
}

async function selectOutboxById(db: Database, outboxId: string): Promise<PurchaseOutboxRow | undefined> {
    return await db
        .select()
        .from(metaCapiPurchaseOutbox)
        .where(eq(metaCapiPurchaseOutbox.id, outboxId))
        .get();
}

async function selectOutboxByOrderId(db: Database, orderId: string): Promise<PurchaseOutboxRow | undefined> {
    return await db
        .select()
        .from(metaCapiPurchaseOutbox)
        .where(eq(metaCapiPurchaseOutbox.orderId, orderId))
        .get();
}

function valuesToRow(values: PurchaseOutboxInsert): PurchaseOutboxRow {
    return {
        id: String(values.id),
        orderId: String(values.orderId),
        eventId: String(values.eventId),
        source: String(values.source),
        status: String(values.status ?? "pending") as MetaCapiPurchaseOutboxStatus,
        attempts: Number(values.attempts ?? 0),
        nextAttemptAt: Number(values.nextAttemptAt ?? 0),
        claimId: null,
        claimExpiresAt: null,
        lastError: null,
        sentAt: null,
        skippedAt: null,
        createdAt: Number(values.createdAt ?? 0),
        updatedAt: Number(values.updatedAt ?? 0),
    };
}

function createOrderSuccessEventSourceUrl(storefrontUrl: string, orderId: string): string {
    const url = new URL("/order-success", storefrontUrl);
    url.searchParams.set("orderId", orderId);
    return url.toString();
}

function normalizeStorefrontUrl(value: string | null | undefined): string | null {
    if (!value || !value.trim()) return null;
    try {
        return new URL(value).origin;
    } catch {
        return null;
    }
}

function splitCustomerName(name: string): [string | null, string | null] {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return [null, null];
    if (parts.length === 1) return [parts[0] ?? null, null];
    return [parts[0] ?? null, parts.slice(1).join(" ") || null];
}

function createOutboxId(): string {
    return `mcap_${createRandomId()}`;
}

function createClaimId(): string {
    return `mcapc_${createRandomId()}`;
}

function createRandomId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID().replace(/-/g, "");
    }
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function getRetryDelaySeconds(attempts: number): number {
    const normalizedAttempts = Math.max(1, Math.min(attempts, 8));
    return Math.min(60 * 60, 60 * 2 ** (normalizedAttempts - 1));
}

function normalizeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}...` : message;
}
