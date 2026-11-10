// The active apps' line inputs (manifest `checkout.lineInputs`) as the staff
// order form asks them: the same apps the staff quote reads, each input with
// the SKUs it applies to (`appLineInputVariantIds`: a SKU's own flag over its
// product's, the rule checkout and the storefront's buy form apply), so staff
// never fill an input the order would refuse. A gift card takes none; an
// app's file input is the buyer's to upload and is not drawn here.
import type { Database } from "@scalius/database/client";
import { products, productVariants } from "@scalius/database/schema";
import { checkoutLineInputs } from "@scalius/core/modules/checkout";
import { listActiveCheckoutRegistrations } from "@scalius/core/modules/plugins";
import { presentCustomizationSchema } from "@scalius/core/modules/products";
import { appFlagsSql } from "@scalius/core/utils/app-flags";
import { appLineInputVariantIds, parseAppLineInputFlags, withAppLineInputs, type LineInputConfirm } from "@scalius/shared/line-properties";
import { and, sql } from "drizzle-orm";
import { createCheckoutAppFunctions } from "../../../plugins/checkout-functions";

/** One app input field of the staff form: the product view's field, its app, and the SKUs it applies to (absent: every SKU). */
type ViewField = NonNullable<ReturnType<typeof presentCustomizationSchema>>["fields"][number];
export type StaffAppInputField = Omit<ViewField, "options"> & {
    appId: string;
    variantIds?: string[];
    /** The revision of the input's words as drawn: the order form sends it back with the answer. */
    textRevision?: string;
    /** `confirm`: a choice taken only once the buyer agrees to its agreement (read out by staff). */
    options: Array<ViewField["options"][number] & { confirm?: LineInputConfirm }>;
};

/**
 * Per product of `productIds` (at most 20, one page of the picker), the app
 * inputs its SKUs take. No active app with line inputs reads nothing more;
 * otherwise one read of the products' flags and, when an input is gated by
 * SKU, one of their live SKUs' flags.
 */
export async function staffAppLineInputs(
    db: Database,
    runtime: { env: Env; ctx: ExecutionContext | undefined; language?: string | null },
    productIds: readonly string[],
    decimalPlaces: number,
): Promise<Map<string, StaffAppInputField[]>> {
    const result = new Map<string, StaffAppInputField[]>();
    if (productIds.length === 0) return result;
    const registrations = await listActiveCheckoutRegistrations(db);
    if (registrations.length === 0) return result;
    const apps = await createCheckoutAppFunctions({ env: runtime.env, ctx: runtime.ctx, db, registrations, ...(runtime.language ? { language: runtime.language } : {}) });
    const lineInputs = checkoutLineInputs(apps);
    if (lineInputs.every((app) => app.inputs.length === 0)) return result;
    const ids = JSON.stringify([...new Set(productIds)]);
    const productRows = await db.select({ id: products.id, isGiftCard: products.isGiftCard, appFlags: appFlagsSql("product", sql`${products.id}`) })
        .from(products).where(sql`${products.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${ids}))`).all();
    const bySku = lineInputs.some((app) => app.inputs.some((input) => input.variants));
    const variantRows = bySku
        ? await db.select({ id: productVariants.id, productId: productVariants.productId, appFlags: appFlagsSql("variant", sql`${productVariants.id}`) })
            .from(productVariants)
            // A filter, not an index: the id set drives the read.
            .where(and(sql`${productVariants.productId} IN (SELECT CAST(value AS TEXT) FROM json_each(${ids}))`, sql`+${productVariants.deletedAt} IS NULL`))
            .orderBy(productVariants.createdAt, productVariants.id).all()
        : [];
    for (const product of productRows) {
        if (product.isGiftCard) continue;
        const flags = parseAppLineInputFlags(product.appFlags);
        const variants = variantRows.filter((row) => row.productId === product.id).map((row) => ({ id: row.id, flags: parseAppLineInputFlags(row.appFlags) }));
        const skus = new Map<string, string[] | null>();
        const schema = withAppLineInputs(null, lineInputs, (appId, input) => {
            const variantIds = appLineInputVariantIds(appId, input, flags, variants);
            skus.set(`${appId}.${input.key}`, variantIds);
            return variantIds === null || variantIds.length > 0;
        });
        const declared = new Map((schema?.fields ?? []).map((field) => [field.key, field]));
        const fields = (presentCustomizationSchema(schema, decimalPlaces)?.fields ?? []).map((field): StaffAppInputField => {
            const variantIds = skus.get(field.key);
            const source = declared.get(field.key)!;
            // A choice taken only with the buyer's agreement: staff read it out, and the answer carries the revision drawn.
            const confirms = new Map(source.type === "select" ? source.options.flatMap((option) => (option.confirm ? [[option.value, option.confirm] as const] : [])) : []);
            return {
                ...field,
                appId: source.appId!,
                ...(variantIds ? { variantIds } : {}),
                ...(source.textRevision ? { textRevision: source.textRevision } : {}),
                ...(confirms.size > 0 ? { options: field.options.map((option) => (confirms.has(option.value) ? { ...option, confirm: confirms.get(option.value)! } : option)) } : {}),
            };
        });
        if (fields.length > 0) result.set(product.id, fields);
    }
    return result;
}
