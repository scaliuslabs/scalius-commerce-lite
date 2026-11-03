// The warranty a product or SKU may point at: a live (not archived) policy.
// Not part of the checkout authority fence: commit freezes whatever revision
// is current, and a warranty never changes the price.
import { chunkForD1, type Database } from "@scalius/database/client";
import { products, warrantyPolicies } from "@scalius/database/schema";
import { eq, inArray } from "drizzle-orm";
import { ValidationError } from "../../errors";
import { skuWarrantyColumns, type SkuWarrantyInput, type SkuWarrantyMode } from "../products";

const UNAVAILABLE_POLICY = "That warranty policy is unavailable or archived. Choose another policy.";

/** Whether each of `policyIds` that exists is live or archived, read in sequential chunks. */
async function warrantyPolicyStates(db: Database, policyIds: readonly string[]): Promise<Map<string, "live" | "archived">> {
    const states = new Map<string, "live" | "archived">();
    for (const chunk of chunkForD1([...new Set(policyIds)])) {
        const rows = await db
            .select({ id: warrantyPolicies.id, archivedAt: warrantyPolicies.archivedAt })
            .from(warrantyPolicies)
            .where(inArray(warrantyPolicies.id, chunk))
            .all();
        for (const row of rows) states.set(row.id, row.archivedAt === null ? "live" : "archived");
    }
    return states;
}

/** The live policies among `policyIds`. */
export async function liveWarrantyPolicyIds(db: Database, policyIds: readonly string[]): Promise<Set<string>> {
    const states = await warrantyPolicyStates(db, policyIds);
    return new Set([...states].filter(([, state]) => state === "live").map(([id]) => id));
}

type SkuWarrantyColumns = { warrantyMode: SkuWarrantyMode; warrantyPolicyId: string | null };

/**
 * The warranty each option-matrix row writes (undefined keeps a saved row's),
 * the one authority for a matrix save:
 * - A gift card's SKUs inherit (a product turning into one is reset in the
 *   same save, whatever the rows send).
 * - A saved SKU may keep a policy archived after it was chosen.
 * - A new or restored row starts at `inherit`. One that names an archived
 *   policy (copied from the row it comes from) sells without a warranty, as
 *   its source does, so it gets `none`.
 * - An unknown policy, or an archived one newly given to a saved SKU, is refused.
 */
export async function planMatrixSkuWarranties(
    db: Database,
    rows: ReadonlyArray<{ input: SkuWarrantyInput; savedPolicyId: string | null | undefined; field: string }>,
    isGiftCard: boolean,
): Promise<Array<SkuWarrantyColumns | undefined>> {
    if (isGiftCard) return rows.map(() => ({ warrantyMode: "inherit", warrantyPolicyId: null }));
    const planned = rows.map((row) => skuWarrantyColumns(row.savedPolicyId === undefined
        ? { warrantyMode: row.input.warrantyMode ?? "inherit", warrantyPolicyId: row.input.warrantyPolicyId }
        : row.input));
    const states = await warrantyPolicyStates(db, planned.flatMap((columns) => columns?.warrantyPolicyId ? [columns.warrantyPolicyId] : []));
    return planned.map((columns, index) => {
        const policyId = columns?.warrantyPolicyId;
        if (!policyId || states.get(policyId) === "live") return columns;
        const row = rows[index]!;
        if (row.savedPolicyId === policyId) return columns;
        if (row.savedPolicyId === undefined && states.get(policyId) === "archived") return { warrantyMode: "none", warrantyPolicyId: null };
        throw new ValidationError(UNAVAILABLE_POLICY, { field: row.field });
    });
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
