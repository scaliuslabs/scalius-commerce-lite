import { productVariants } from "@scalius/database/schema";
import { sql, type SQL } from "drizzle-orm";

/**
 * Matches the partial normalized barcode index predicate exactly. SQLite does
 * not infer the non-null/non-empty predicate from an expression equality, so
 * every indexed lookup must use this shared boundary. The identity list binds
 * as bare json_each values: a CAST there keeps SQLite off the expression index.
 */
export function productVariantBarcodeIdentityEquals(identity: string): SQL {
    return sql`${productVariants.barcode} IS NOT NULL
        AND trim(${productVariants.barcode}) <> ''
        AND lower(trim(${productVariants.barcode})) = ${identity}`;
}

export function productVariantBarcodeIdentityIn(identities: readonly string[]): SQL {
    return sql`${productVariants.barcode} IS NOT NULL
        AND trim(${productVariants.barcode}) <> ''
        AND lower(trim(${productVariants.barcode})) IN (
            SELECT value FROM json_each(${JSON.stringify(identities)})
        )`;
}
