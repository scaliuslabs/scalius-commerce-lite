// Which customer tags and segments something money-relevant selects by: net
// terms (by tag or segment), segment price lists, and discounts limited to
// segments, plus the tags a referenced segment's definition reads. A tag or
// segment write changes what a buyer pays only when it touches one of these;
// every other tag or segment write is ordinary marketing (agent approval:
// ./money-change.ts). Making something reference a tag or segment (a price
// list, a discount, the payment settings) is itself a money write.
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "@scalius/database/client";
import { customerSegments, customerTagLinks, priceLists, promotionConditions, promotionCustomerSegments, promotionEffects } from "@scalius/database/schema";

export interface MoneyReferences {
  tags: ReadonlySet<string>;
  segmentIds: ReadonlySet<string>;
  /** Collections a discount's conditions or effects target. */
  collectionIds: ReadonlySet<string>;
  /** The customer attributes a referenced segment's definition reads (`city`, `zone`, `marketing_consent`, `customer_type`, `custom_field`). */
  customerAttributes: ReadonlySet<string>;
}

type Condition = { field?: unknown; tags?: unknown };

function conditionsOf(definition: string): Condition[] {
  try {
    const parsed = JSON.parse(definition) as { conditions?: Condition[] };
    return Array.isArray(parsed.conditions) ? parsed.conditions : [];
  } catch {
    return [];
  }
}

function tagsOfDefinition(definition: string): string[] {
  return conditionsOf(definition).flatMap((condition) =>
    condition.field === "tags" && Array.isArray(condition.tags) ? condition.tags.filter((tag): tag is string => typeof tag === "string") : []);
}

/** Every `collectionIds` entry anywhere in a discount condition's or effect's config. */
function collectionIdsOf(config: string): string[] {
  const found: string[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (key === "collectionIds" && Array.isArray(item)) found.push(...item.filter((id): id is string => typeof id === "string"));
        else walk(item);
      }
    }
  };
  try {
    walk(JSON.parse(config));
  } catch {
    // An unreadable config targets nothing this check can name.
  }
  return found;
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
  const customerAttributes = new Set<string>();
  if (segmentIds.size > 0) {
    const definitions = await db.select({ definition: customerSegments.definition }).from(customerSegments)
      .where(and(inArray(customerSegments.id, [...segmentIds]), isNull(customerSegments.deletedAt)));
    for (const { definition } of definitions) {
      for (const tag of tagsOfDefinition(definition)) tags.add(tag.toLowerCase());
      for (const condition of conditionsOf(definition)) if (typeof condition.field === "string") customerAttributes.add(condition.field);
    }
  }
  const collectionIds = new Set<string>();
  for (const table of [promotionConditions, promotionEffects]) {
    for (const row of await db.select({ config: table.config }).from(table)) for (const id of collectionIdsOf(row.config)) collectionIds.add(id);
  }
  return { tags, segmentIds, collectionIds, customerAttributes };
}

/** A customer's stored tags. */
export async function readCustomerTags(env: Env, customerId: string): Promise<string[]> {
  const rows = await getDb(env).select({ tag: customerTagLinks.tag }).from(customerTagLinks).where(eq(customerTagLinks.customerId, customerId));
  return rows.map((row) => row.tag);
}
