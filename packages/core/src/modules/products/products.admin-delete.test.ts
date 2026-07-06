import { describe, expect, it, vi } from "vitest";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { ConflictError } from "@scalius/core/errors";
import { productLowStockAlerts, productVariants } from "@scalius/database/schema";
import { bulkDeleteProducts, permanentlyDeleteProduct } from "./products.admin";

type DeleteStatement = {
    kind: "delete";
    table: unknown;
    condition: unknown;
};

function createProductDeleteDb(selectRows: unknown[][]) {
    let selectIndex = 0;
    const batchCalls: unknown[][] = [];
    const deleteStatements: DeleteStatement[] = [];

    const db = {
        select: vi.fn(() => ({
            from: vi.fn(() => ({
                where: vi.fn(async () => selectRows[selectIndex++] ?? []),
            })),
        })),
        delete: vi.fn((table: unknown) => ({
            where: vi.fn((condition: unknown) => {
                const statement: DeleteStatement = { kind: "delete", table, condition };
                deleteStatements.push(statement);
                return statement;
            }),
        })),
        batch: vi.fn(async (statements: unknown[]) => {
            batchCalls.push(statements);
            return statements;
        }),
    };

    return { db, batchCalls, deleteStatements };
}

function compiledConditionSql(condition: unknown): string {
    return new SQLiteSyncDialect().sqlToQuery(condition as never).sql;
}

function expectLowStockAlertCleanupBeforeVariantDelete(batch: unknown[]) {
    const deleteBatch = batch as DeleteStatement[];
    const lowStockAlertIndex = deleteBatch.findIndex((statement) => statement.table === productLowStockAlerts);
    const variantDeleteIndex = deleteBatch.findIndex((statement) => statement.table === productVariants);

    expect(lowStockAlertIndex).toBeGreaterThanOrEqual(0);
    expect(variantDeleteIndex).toBeGreaterThanOrEqual(0);
    expect(lowStockAlertIndex).toBeLessThan(variantDeleteIndex);

    const lowStockAlertSql = compiledConditionSql(deleteBatch[lowStockAlertIndex]!.condition);
    expect(lowStockAlertSql).toContain("product_id");
    expect(lowStockAlertSql).toContain("variant_id");
}

describe("admin product permanent delete inventory guards", () => {
    it("rejects single permanent product delete when a SKU has inventory history", async () => {
        const { db, batchCalls } = createProductDeleteDb([
            [{ count: 0 }],
            [{ count: 0 }],
            [{ id: "var_history" }],
            [{ count: 1 }],
        ]);

        await expect(
            permanentlyDeleteProduct(db as never, "prod_1"),
        ).rejects.toBeInstanceOf(ConflictError);

        expect(db.delete).not.toHaveBeenCalled();
        expect(batchCalls).toHaveLength(0);
    });

    it("rejects bulk permanent product delete when any SKU has inventory history", async () => {
        const { db, batchCalls } = createProductDeleteDb([
            [{ count: 0 }],
            [{ count: 0 }],
            [{ id: "var_clean" }, { id: "var_history" }],
            [{ count: 1 }],
        ]);

        await expect(
            bulkDeleteProducts(db as never, ["prod_1", "prod_2"], true),
        ).rejects.toBeInstanceOf(ConflictError);

        expect(db.delete).not.toHaveBeenCalled();
        expect(batchCalls).toHaveLength(0);
    });

    it("clears low-stock alerts before deleting variants during single no-history permanent delete", async () => {
        const { db, batchCalls } = createProductDeleteDb([
            [{ count: 0 }],
            [{ count: 0 }],
            [{ id: "var_clean" }],
            [{ count: 0 }],
        ]);

        await permanentlyDeleteProduct(db as never, "prod_1");

        expect(db.delete).toHaveBeenCalledWith(productLowStockAlerts);
        expect(batchCalls).toHaveLength(1);
        expectLowStockAlertCleanupBeforeVariantDelete(batchCalls[0]!);
    });

    it("clears low-stock alerts before deleting variants during bulk no-history permanent delete", async () => {
        const { db, batchCalls } = createProductDeleteDb([
            [{ count: 0 }],
            [{ count: 0 }],
            [{ id: "var_clean_1" }, { id: "var_clean_2" }],
            [{ count: 0 }],
        ]);

        await bulkDeleteProducts(db as never, ["prod_1", "prod_2"], true);

        expect(db.delete).toHaveBeenCalledWith(productLowStockAlerts);
        expect(batchCalls).toHaveLength(1);
        expectLowStockAlertCleanupBeforeVariantDelete(batchCalls[0]!);
    });
});
