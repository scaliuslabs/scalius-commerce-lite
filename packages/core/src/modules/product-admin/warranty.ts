// The warranty a product or SKU may point at: a live (not archived) policy.
// Not part of the checkout authority fence: commit freezes whatever revision
// is current, and a warranty never changes the price.
import { chunkForD1, type Database } from "@scalius/database/client";
import { products, warrantyPolicies } from "@scalius/database/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { ValidationError } from "../../errors";

const UNAVAILABLE_POLICY = "That warranty policy is unavailable or archived. Choose another policy.";

/** The live policies among `policyIds`, read in sequential chunks. */
export async function liveWarrantyPolicyIds(db: Database, policyIds: readonly string[]): Promise<Set<string>> {
    const live = new Set<string>();
    for (const chunk of chunkForD1([...new Set(policyIds)])) {
        const rows = await db
            .select({ id: warrantyPolicies.id })
            .from(warrantyPolicies)
            .where(and(inArray(warrantyPolicies.id, chunk), isNull(warrantyPolicies.archivedAt)))
            .all();
        for (const row of rows) live.add(row.id);
    }
    return live;
}

/**
 * Only an option SKU of a product that is not a gift card has a warranty of
 * its own (what the editor shows): a product's one SKU takes the product's
 * warranty, and a gift card's denominations have none of their own.
 */
export function assertSkuWarrantyAllowed(
    input: { warrantyMode?: string | undefined },
    sku: { isDefault: boolean; isGiftCard: boolean; field: string },
): void {
    if (input.warrantyMode === undefined || input.warrantyMode === "inherit") return;
    if (sku.isGiftCard) {
        throw new ValidationError("A gift card has no warranty of its own. Leave each denomination on the product's warranty.", { field: sku.field });
    }
    if (sku.isDefault) {
        throw new ValidationError("A product without options has one warranty: set it on the product.", { field: sku.field });
    }
}

/** Whether the product is a gift card (a SKU write that sets a warranty asks). */
export async function productIsGiftCard(db: Database, productId: string): Promise<boolean> {
    const row = await db.select({ isGiftCard: products.isGiftCard }).from(products).where(eq(products.id, productId)).get();
    return row?.isGiftCard === true;
}

/** A product's policy: it exists and is not archived (omitted or null passes). */
export async function assertLiveWarrantyPolicy(db: Database, policyId: string | null | undefined): Promise<void> {
    if (!policyId) return;
    if (!(await liveWarrantyPolicyIds(db, [policyId])).has(policyId)) {
        throw new ValidationError(UNAVAILABLE_POLICY, { field: "warrantyPolicyId" });
    }
}

/**
 * SKU warranty picks: a policy the SKU does not already name must be live. A
 * SKU that keeps the policy it was saved with may keep it after the policy
 * was archived (it then freezes no warranty), so re-saving a matrix never
 * fails on a policy the merchant did not touch.
 */
export async function assertLiveSkuWarrantyPolicies(
    db: Database,
    picks: ReadonlyArray<{ policyId: string | null | undefined; savedPolicyId?: string | null; field: string }>,
): Promise<void> {
    const changed = picks.filter((pick): pick is typeof pick & { policyId: string } =>
        Boolean(pick.policyId) && pick.policyId !== pick.savedPolicyId);
    if (changed.length === 0) return;
    const live = await liveWarrantyPolicyIds(db, changed.map((pick) => pick.policyId));
    const refused = changed.find((pick) => !live.has(pick.policyId));
    if (refused) throw new ValidationError(UNAVAILABLE_POLICY, { field: refused.field });
}
