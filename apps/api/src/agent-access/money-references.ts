// Which customer tags and segments something money-relevant selects by: net
// terms (by tag or segment), segment price lists, and discounts limited to
// segments, plus the tags a referenced segment's definition reads. A tag or
// segment write changes what a buyer pays only when it touches one of these;
// every other tag or segment write is ordinary marketing (agent approval:
// ./money-change.ts). Making something reference a tag or segment (a price
// list, a discount, the payment settings) is itself a money write.
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "@scalius/database/client";
import { customerSegments, customerTagLinks, priceLists, promotionCustomerSegments } from "@scalius/database/schema";

export interface MoneyReferences {
  tags: ReadonlySet<string>;
  segmentIds: ReadonlySet<string>;
}

function tagsOfDefinition(definition: string): string[] {
  try {
    const parsed = JSON.parse(definition) as { conditions?: Array<{ field?: unknown; tags?: unknown }> };
    return (parsed.conditions ?? []).flatMap((condition) =>
      condition.field === "tags" && Array.isArray(condition.tags) ? condition.tags.filter((tag): tag is string => typeof tag === "string") : []);
  } catch {
    return [];
  }
}

export async function readMoneyReferences(env: Env): Promise<MoneyReferences> {
  const db = getDb(env);
  const { paymentMethodsDocument } = await import("@scalius/core/modules/settings");
  const netTerms = (await paymentMethodsDocument.read(db)).netTerms;
  const segmentIds = new Set<string>(netTerms.segmentIds ?? []);
  const tags = new Set<string>((netTerms.customerTags ?? []).map((tag) => tag.toLowerCase()));
  for (const row of await db.selectDistinct({ id: priceLists.segmentId }).from(priceLists).where(isNotNull(priceLists.segmentId))) {
    if (row.id) segmentIds.add(row.id);
  }
  for (const row of await db.selectDistinct({ id: promotionCustomerSegments.segmentId }).from(promotionCustomerSegments)) segmentIds.add(row.id);
  if (segmentIds.size > 0) {
    const definitions = await db.select({ definition: customerSegments.definition }).from(customerSegments)
      .where(and(inArray(customerSegments.id, [...segmentIds]), isNull(customerSegments.deletedAt)));
    for (const { definition } of definitions) for (const tag of tagsOfDefinition(definition)) tags.add(tag.toLowerCase());
  }
  return { tags, segmentIds };
}

/** A customer's stored tags. */
export async function readCustomerTags(env: Env, customerId: string): Promise<string[]> {
  const rows = await getDb(env).select({ tag: customerTagLinks.tag }).from(customerTagLinks).where(eq(customerTagLinks.customerId, customerId));
  return rows.map((row) => row.tag);
}
