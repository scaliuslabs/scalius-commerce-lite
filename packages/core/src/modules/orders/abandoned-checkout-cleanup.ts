import { inArray, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { abandonedCheckouts } from "@scalius/database/schema";

export const DEFAULT_ABANDONED_CHECKOUT_RETENTION_DAYS = 30;
export const DEFAULT_EMPTY_ABANDONED_CHECKOUT_MAX_AGE_MINUTES = 60;
export const DEFAULT_ABANDONED_CHECKOUT_CLEANUP_LIMIT = 100;
export const MAX_ABANDONED_CHECKOUT_CLEANUP_LIMIT = 500;

export interface AbandonedCheckoutCleanupOptions {
    retentionDays?: number;
    emptyMaxAgeMinutes?: number;
    limit?: number;
}

export interface AbandonedCheckoutCleanupResult {
    scannedExpired: number;
    deletedExpired: number;
    scannedEmpty: number;
    deletedEmpty: number;
    limit: number;
    hasMore: boolean;
}

interface AbandonedCheckoutEmptyCandidate {
    id: string;
    checkoutData: string;
    customerPhone: string | null;
}

function normalizeInteger(value: number | undefined, fallback: number, max: number): number {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    return Math.max(1, Math.min(max, Math.floor(value)));
}

function normalizePositiveNumber(value: number | undefined, fallback: number): number {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    return Math.max(1, value);
}

export function isAbandonedCheckoutEmpty(checkout: {
    checkoutData: string;
    customerPhone: string | null;
}): boolean {
    if (checkout.customerPhone) return false;

    try {
        const data = JSON.parse(checkout.checkoutData);
        const items = data.items || [];
        const customerInfo = data.customerInfo || {};

        const hasItems = Array.isArray(items) && items.length > 0;
        const hasCustomerInfo = Object.values(customerInfo).some((value) => !!value);

        return !hasItems && !hasCustomerInfo;
    } catch {
        return true;
    }
}

export async function cleanupStaleAbandonedCheckouts(
    db: Database,
    nowSeconds: number,
    options: AbandonedCheckoutCleanupOptions = {},
): Promise<AbandonedCheckoutCleanupResult> {
    const limit = normalizeInteger(
        options.limit,
        DEFAULT_ABANDONED_CHECKOUT_CLEANUP_LIMIT,
        MAX_ABANDONED_CHECKOUT_CLEANUP_LIMIT,
    );
    const retentionDays = normalizePositiveNumber(
        options.retentionDays,
        DEFAULT_ABANDONED_CHECKOUT_RETENTION_DAYS,
    );
    const emptyMaxAgeMinutes = normalizePositiveNumber(
        options.emptyMaxAgeMinutes,
        DEFAULT_EMPTY_ABANDONED_CHECKOUT_MAX_AGE_MINUTES,
    );

    const result: AbandonedCheckoutCleanupResult = {
        scannedExpired: 0,
        deletedExpired: 0,
        scannedEmpty: 0,
        deletedEmpty: 0,
        limit,
        hasMore: false,
    };

    const expiredCutoff = Math.floor(nowSeconds - retentionDays * 24 * 60 * 60);
    const emptyCutoff = Math.floor(nowSeconds - emptyMaxAgeMinutes * 60);

    const expiredRows = await db
        .select({ id: abandonedCheckouts.id })
        .from(abandonedCheckouts)
        .where(sql`${abandonedCheckouts.createdAt} <= ${expiredCutoff}`)
        .limit(limit + 1);
    const expiredIds = expiredRows.slice(0, limit).map((row) => row.id);

    result.scannedExpired = expiredIds.length;
    result.hasMore = expiredRows.length > limit;

    if (expiredIds.length > 0) {
        await db.delete(abandonedCheckouts).where(inArray(abandonedCheckouts.id, expiredIds));
        result.deletedExpired = expiredIds.length;
    }

    const remainingLimit = Math.max(0, limit - expiredIds.length);
    if (remainingLimit === 0) {
        return result;
    }

    const oldCandidates = await db
        .select({
            id: abandonedCheckouts.id,
            checkoutData: abandonedCheckouts.checkoutData,
            customerPhone: abandonedCheckouts.customerPhone,
        })
        .from(abandonedCheckouts)
        .where(sql`${abandonedCheckouts.updatedAt} <= ${emptyCutoff}`)
        .limit(remainingLimit + 1) as AbandonedCheckoutEmptyCandidate[];
    const boundedCandidates = oldCandidates.slice(0, remainingLimit);
    const emptyIds = boundedCandidates
        .filter((checkout) => isAbandonedCheckoutEmpty(checkout))
        .map((checkout) => checkout.id);

    result.scannedEmpty = boundedCandidates.length;
    result.hasMore = result.hasMore || oldCandidates.length > remainingLimit;

    if (emptyIds.length > 0) {
        await db.delete(abandonedCheckouts).where(inArray(abandonedCheckouts.id, emptyIds));
        result.deletedEmpty = emptyIds.length;
    }

    return result;
}
