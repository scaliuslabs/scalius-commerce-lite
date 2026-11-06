// Discounts as their webhooks carry them (`EVENT_REPRESENTATION_SCHEMAS.discount`),
// read for a page of ids in one batch: the promotions, then their code and
// redemption counts grouped by discount, every id list bound as one JSON
// value. The stable `discounts.list` reads them here; its truncated delivery
// points at `discounts.get` for the rules.
import type { Database } from "@scalius/database/client";
import { promotionCodes, promotionRedemptions, promotions } from "@scalius/database/schema";
import { inJsonArray } from "@scalius/core/utils/in-json-array";
import { buildEventRepresentation, type EventRepresentation } from "@scalius/shared/events";
import { allProtectedData } from "@scalius/shared/plugins/protected-data";
import { count } from "drizzle-orm";

/** Discounts one read takes: a page of a list (D1 binds the list as one value). */
export const DISCOUNT_REPRESENTATIONS_MAX = 90;

const iso = (value: Date | null | undefined): string | null => (value && Number.isFinite(value.getTime()) ? value.toISOString() : null);

/** These discounts (archived ones too), in the order asked; unknown ids are left out. */
export async function readDiscountRepresentations(db: Database, ids: readonly string[]): Promise<EventRepresentation<"discount">[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  if (unique.length > DISCOUNT_REPRESENTATIONS_MAX) throw new RangeError(`Read at most ${DISCOUNT_REPRESENTATIONS_MAX} discounts at once.`);
  const [rows, codes, redemptions] = await db.batch([
    db.select().from(promotions).where(inJsonArray(promotions.id, unique)),
    db.select({ id: promotionCodes.promotionId, count: count() }).from(promotionCodes)
      .where(inJsonArray(promotionCodes.promotionId, unique)).groupBy(promotionCodes.promotionId),
    db.select({ id: promotionRedemptions.promotionId, count: count() }).from(promotionRedemptions)
      .where(inJsonArray(promotionRedemptions.promotionId, unique)).groupBy(promotionRedemptions.promotionId),
  ]);
  const codeCount = new Map(codes.map((row) => [row.id, Number(row.count)]));
  const redemptionCount = new Map(redemptions.map((row) => [row.id, Number(row.count)]));
  const byId = new Map(rows.map((promotion) => [promotion.id, buildEventRepresentation("discount", {
    id: promotion.id,
    name: promotion.name,
    title: promotion.title ?? null,
    method: promotion.method,
    status: promotion.status,
    priority: promotion.priority,
    revision: promotion.revision,
    codeCount: codeCount.get(promotion.id) ?? 0,
    startsAt: iso(promotion.startsAt),
    endsAt: iso(promotion.endsAt),
    maxRedemptions: promotion.maxRedemptions ?? null,
    redemptions: redemptionCount.get(promotion.id) ?? 0,
    createdAt: iso(promotion.createdAt) ?? new Date(0).toISOString(),
    updatedAt: iso(promotion.updatedAt) ?? new Date(0).toISOString(),
    deletedAt: iso(promotion.deletedAt),
  }, allProtectedData())]));
  return unique.flatMap((id) => byId.get(id) ?? []);
}
