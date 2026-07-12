import { describe, expect, it, vi } from "vitest";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/d1";
import { ConflictError } from "@scalius/core/errors";
import { productLowStockAlerts, productVariants } from "@scalius/database/schema";
import {
    buildPermanentProductDeleteBatch,
    bulkDeleteProducts,
    permanentlyDeleteProduct,
} from "./products.admin";

type DeleteStatement = {
    kind: "delete";
    table: unknown;
    condition: unknown;
};

function createProductDeleteDb(
    selectRows: unknown[][],
    batchErrors: Array<Error | undefined> = [],
) {
    let selectIndex = 0;
    const batchCalls: unknown[][] = [];
    const deleteStatements: DeleteStatement[] = [];

    const db = {
        run: vi.fn(() => ({ kind: "guard" })),
        select: vi.fn(() => ({
            from: vi.fn(() => ({
                kind: "guard",
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
            const error = batchErrors[batchCalls.length - 1];
            if (error) throw error;
            return statements;
        }),
    };

    return { db, batchCalls, deleteStatements };
}

function compiledConditionSql(condition: unknown): string {
    return new SQLiteSyncDialect().sqlToQuery(condition as never).sql;
}

function compiledConditionParams(condition: unknown): unknown[] {
    return new SQLiteSyncDialect().sqlToQuery(condition as never).params;
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
    it("compiles the permanent-delete batch without ambiguous columns", () => {
        const db = drizzle({} as D1Database);
        const statements = buildPermanentProductDeleteBatch(
            db as never,
            "prod_1",
            1,
            ["var_1"],
        );
        const referenceGuard = (statements[1] as unknown as {
            toSQL(): { sql: string };
        }).toSQL().sql;

        expect(referenceGuard).toContain(
            'ON "permanent_delete_inventory_movement"."variant_id" = "permanent_delete_product_variant"."id"',
        );
        expect(referenceGuard).toContain(
            'WHERE "permanent_delete_product_variant"."product_id" IN',
        );
        expect(referenceGuard).not.toContain('ON "variant_id" = "id"');
    });
    it("rejects single permanent product delete when a SKU has inventory history", async () => {
        const { db, batchCalls } = createProductDeleteDb([
            [{ count: 0 }],
            [{ count: 0 }],
            [{ id: "var_history" }],
            [{ count: 1 }],
        ]);

        await expect(
            permanentlyDeleteProduct(db as never, "prod_1", 1),
        ).rejects.toBeInstanceOf(ConflictError);

        expect(db.delete).not.toHaveBeenCalled();
        expect(batchCalls).toHaveLength(0);
    });

    it("keeps blocked history rows in trash while deleting unrelated safe rows", async () => {
        const { db, batchCalls } = createProductDeleteDb([
            [{ count: 0 }],
            [{ count: 0 }],
            [{ id: "var_history" }],
            [{ count: 1 }],
            [{ count: 0 }],
            [{ count: 0 }],
            [{ id: "var_clean" }],
            [{ count: 0 }],
        ]);

        await expect(bulkDeleteProducts(db as never, [
                { id: "prod_1", expectedAggregateRevision: 1 },
                { id: "prod_2", expectedAggregateRevision: 1 },
            ], true)).resolves.toEqual({
                revisions: [],
                outcomes: [
                    {
                        id: "prod_1",
                        status: "blocked",
                        code: "CONFLICT",
                        message: "Cannot permanently delete product. One or more SKUs have inventory history; move the product to trash instead.",
                    },
                    {
                        id: "prod_2",
                        status: "deleted",
                        code: null,
                        message: null,
                    },
                ],
            });

        expect(batchCalls).toHaveLength(1);
    });

    it("keeps order-history rows in trash while deleting the next safe product", async () => {
        const { db, batchCalls } = createProductDeleteDb([
            [{ count: 1 }],
            [{ count: 0 }],
            [{ count: 0 }],
            [{ id: "var_clean" }],
            [{ count: 0 }],
        ]);

        const result = await bulkDeleteProducts(db as never, [
            { id: "prod_ordered", expectedAggregateRevision: 1 },
            { id: "prod_clean", expectedAggregateRevision: 1 },
        ], true);

        expect(result.outcomes).toEqual([
            {
                id: "prod_ordered",
                status: "blocked",
                code: "CONFLICT",
                message: "Cannot delete product. It is part of one or more existing orders.",
            },
            {
                id: "prod_clean",
                status: "deleted",
                code: null,
                message: null,
            },
        ]);
        expect(batchCalls).toHaveLength(1);
    });

    it("clears low-stock alerts before deleting variants during single no-history permanent delete", async () => {
        const { db, batchCalls } = createProductDeleteDb([
            [{ count: 0 }],
            [{ count: 0 }],
            [{ id: "var_clean" }],
            [{ count: 0 }],
        ]);

        await permanentlyDeleteProduct(db as never, "prod_1", 1);

        expect(db.delete).toHaveBeenCalledWith(productLowStockAlerts);
        expect(batchCalls).toHaveLength(1);
        expect(batchCalls[0]?.filter((statement) =>
            (statement as { kind?: string }).kind === "guard"
        )).toHaveLength(2);
        expectLowStockAlertCleanupBeforeVariantDelete(batchCalls[0]!);
    });

    it("clears low-stock alerts before deleting variants during bulk no-history permanent delete", async () => {
        const { db, batchCalls } = createProductDeleteDb([
            [{ count: 0 }],
            [{ count: 0 }],
            [{ id: "var_clean_1" }],
            [{ count: 0 }],
            [{ count: 0 }],
            [{ count: 0 }],
            [{ id: "var_clean_2" }],
            [{ count: 0 }],
        ]);

        await bulkDeleteProducts(db as never, [
            { id: "prod_1", expectedAggregateRevision: 1 },
            { id: "prod_2", expectedAggregateRevision: 1 },
        ], true);

        expect(db.delete).toHaveBeenCalledWith(productLowStockAlerts);
        expect(batchCalls).toHaveLength(2);
        for (const batch of batchCalls) {
            expect(batch.filter((statement) =>
                (statement as { kind?: string }).kind === "guard"
            )).toHaveLength(2);
            expectLowStockAlertCleanupBeforeVariantDelete(batch);
        }
    });

    it("binds large SKU cleanup sets as JSON lookup values instead of one parameter per SKU", async () => {
        const variantRows = Array.from({ length: 150 }, (_, index) => ({
            id: `var_${index}`,
        }));
        const { db, batchCalls } = createProductDeleteDb([
            [{ count: 0 }],
            [{ count: 0 }],
            variantRows,
            [{ count: 0 }],
        ]);

        await permanentlyDeleteProduct(db as never, "prod_large", 1);

        const lowStockDelete = (batchCalls[0] as DeleteStatement[]).find(
            (statement) => statement.table === productLowStockAlerts,
        );
        expect(lowStockDelete).toBeDefined();
        expect(compiledConditionParams(lowStockDelete!.condition)).toHaveLength(2);
        expect(compiledConditionSql(lowStockDelete!.condition)).toContain("json_each");
    });

    it("reports an unexpected per-row D1 failure and continues with the next safe product", async () => {
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const emptyChecks = [
            [{ count: 0 }],
            [{ count: 0 }],
            [{ id: "var_1" }],
            [{ count: 0 }],
        ];
        const { db, batchCalls } = createProductDeleteDb(
            [
                ...emptyChecks,
                // permanentlyDeleteProduct re-checks references after a batch error.
                ...emptyChecks,
                [{ count: 0 }],
                [{ count: 0 }],
                [{ id: "var_2" }],
                [{ count: 0 }],
            ],
            [new Error("too many SQL variables"), undefined],
        );

        const result = await bulkDeleteProducts(db as never, [
            { id: "prod_failed", expectedAggregateRevision: 1 },
            { id: "prod_safe", expectedAggregateRevision: 1 },
        ], true);

        expect(result.outcomes).toEqual([
            {
                id: "prod_failed",
                status: "failed",
                code: "PRODUCT_PERMANENT_DELETE_FAILED",
                message: expect.stringContaining("Retry it individually"),
            },
            {
                id: "prod_safe",
                status: "deleted",
                code: null,
                message: null,
            },
        ]);
        expect(batchCalls).toHaveLength(2);
        expect(consoleError).toHaveBeenCalledWith(
            "[Products] Permanent delete failed unexpectedly",
            expect.objectContaining({
                productIdPrefix: "prod_failed",
                errorMessage: "too many SQL variables",
            }),
        );
        consoleError.mockRestore();
    });
});
