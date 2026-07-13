import type { Database } from "@scalius/database/client";
import {
    promotionCodes,
    promotionEffects,
    promotions,
} from "@scalius/database/schema";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { and, eq, isNull, sql } from "drizzle-orm";

import { loadPromotionRuntimeCandidate } from "./promotions.checkout";
import { executePromotionRuleMutationBatch } from "./promotions.revision";

export type PromotionLifecycleStatus = "active" | "paused";

export async function activatePromotion(
    db: Database,
    promotionId: string,
    expectedRevision: number,
    evaluatedAtEpochSeconds = Math.floor(Date.now() / 1_000),
): Promise<{ id: string; revision: number; status: "active" }> {
    const parent = await db.select({
        id: promotions.id,
        method: promotions.method,
        status: promotions.status,
    }).from(promotions).where(eq(promotions.id, promotionId)).get();
    if (!parent) throw new NotFoundError("Promotion not found");
    if (parent.status === "archived") throw new ConflictError("Archived promotions cannot be activated.");
    if (parent.status === "active") throw new ConflictError("Promotion is already active.");
    if (parent.method !== "code") {
        throw new ValidationError("Automatic promotions are not available for activation yet.");
    }
    const [activeCode, activeEffect] = await db.batch([
        db.select({ id: promotionCodes.id }).from(promotionCodes).where(and(
            eq(promotionCodes.promotionId, promotionId),
            eq(promotionCodes.isActive, true),
        )).limit(1),
        db.select({ id: promotionEffects.id }).from(promotionEffects).where(and(
            eq(promotionEffects.promotionId, promotionId),
            isNull(promotionEffects.deletedAt),
        )).limit(1),
    ]);
    if (!activeCode[0]) {
        throw new ValidationError("Activate at least one promotion code before activation.");
    }
    if (!activeEffect[0]) {
        throw new ValidationError("Add at least one promotion effect before activation.");
    }

    const promotion = await loadPromotionRuntimeCandidate(db, promotionId, null);
    if (!promotion) throw new NotFoundError("Promotion not found");
    if (promotion.endsAtEpochSeconds !== null && promotion.endsAtEpochSeconds <= evaluatedAtEpochSeconds) {
        throw new ValidationError("A promotion whose schedule has ended cannot be activated.");
    }
    if (
        promotion.maxRedemptions !== null
        && promotion.redemptionCount >= promotion.maxRedemptions
    ) {
        throw new ValidationError("A promotion with an exhausted redemption limit cannot be activated.");
    }
    if (
        promotion.maxDiscountSpendMinor !== null
        && promotion.discountSpendMinor >= promotion.maxDiscountSpendMinor
    ) {
        throw new ValidationError("A promotion with an exhausted spend budget cannot be activated.");
    }

    const result = await executePromotionRuleMutationBatch(db, promotionId, expectedRevision, [
        db.update(promotions).set({
            status: "active",
            updatedAt: sql`unixepoch()`,
        }).where(eq(promotions.id, promotionId)),
    ]);
    return { id: promotionId, revision: result.revision, status: "active" };
}

export async function pausePromotion(
    db: Database,
    promotionId: string,
    expectedRevision: number,
): Promise<{ id: string; revision: number; status: "paused" }> {
    const promotion = await loadPromotionRuntimeCandidate(db, promotionId, null);
    if (!promotion) throw new NotFoundError("Promotion not found");
    if (promotion.status !== "active") {
        throw new ConflictError("Only an active promotion can be paused.");
    }
    const result = await executePromotionRuleMutationBatch(db, promotionId, expectedRevision, [
        db.update(promotions).set({
            status: "paused",
            updatedAt: sql`unixepoch()`,
        }).where(eq(promotions.id, promotionId)),
    ]);
    return { id: promotionId, revision: result.revision, status: "paused" };
}
