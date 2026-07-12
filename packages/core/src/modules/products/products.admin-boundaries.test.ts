import { describe, expect, it } from "vitest";
import { ValidationError } from "@scalius/core/errors";
import { createProduct, restoreProduct, updateProduct } from "./products.admin";

const productUpdate = {
    id: "prod_1",
    name: "Strict SKU Product",
    description: "A product with strict SKU invariants.",
    price: 250,
    categoryId: "cat_1",
    slug: "strict-sku-product",
    metaTitle: null,
    metaDescription: null,
    canonicalPath: null,
    noIndex: false,
    excludeFromSitemap: false,
    excludeFromProductFeed: false,
    productCondition: "new" as const,
    isActive: true,
    discountType: "percentage" as const,
    discountPercentage: 0,
    discountAmount: 0,
    freeDelivery: false,
    images: [],
    attributes: [],
    additionalInfo: [],
    expectedAggregateRevision: 1,
};

describe("admin product SKU invariant boundaries", () => {
    it("fails product updates when a non-default SKU has no customer option", async () => {
        let selectCount = 0;
        let batchCalled = false;
        const db = {
            run() { return { kind: "guard" }; },
            select() {
                selectCount++;
                return {
                    from() {
                        return {
                            where() {
                                if (selectCount === 3) {
                                    return Promise.resolve([
                                        {
                                            id: "var_bad",
                                            isDefault: false,
                                            size: null,
                                            color: null,
                                        },
                                    ]);
                                }
                                if (selectCount === 4) return Promise.resolve([]);

                                return {
                                    get: async () => {
                                        if (selectCount === 1) return { id: "prod_1" };
                                        if (selectCount === 2) return null;
                                        return undefined;
                                    },
                                };
                            },
                        };
                    },
                };
            },
            update() {
                return {
                    set() {
                        return {
                            where() {
                                return {
                                    returning() {
                                        return { statement: "update" };
                                    },
                                };
                            },
                        };
                    },
                };
            },
            delete() {
                return {
                    where() {
                        return {};
                    },
                };
            },
            batch: async (statements: unknown[]) => {
                batchCalled = true;
                return statements.map((_, index) =>
                    index === 1 ? [{ aggregateRevision: 2 }] : []
                );
            },
        };

        await expect(
            updateProduct(db as never, "prod_1", productUpdate),
        ).rejects.toBeInstanceOf(ValidationError);
        expect(batchCalled).toBe(false);
    });

    it("fails product updates when optioned SKUs mix option axes", async () => {
        let selectCount = 0;
        let batchCalled = false;
        const db = {
            run() { return { kind: "guard" }; },
            select() {
                selectCount++;
                return {
                    from() {
                        return {
                            where() {
                                if (selectCount === 3) {
                                    return Promise.resolve([
                                        {
                                            id: "var_size",
                                            isDefault: false,
                                            size: "M",
                                            color: null,
                                        },
                                        {
                                            id: "var_color",
                                            isDefault: false,
                                            size: null,
                                            color: "Red",
                                        },
                                    ]);
                                }
                                if (selectCount === 4) return Promise.resolve([]);

                                return {
                                    get: async () => {
                                        if (selectCount === 1) return { id: "prod_1" };
                                        if (selectCount === 2) return null;
                                        return undefined;
                                    },
                                };
                            },
                        };
                    },
                };
            },
            update() {
                return {
                    set() {
                        return {
                            where() {
                                return {
                                    returning() {
                                        return { statement: "update" };
                                    },
                                };
                            },
                        };
                    },
                };
            },
            delete() {
                return {
                    where() {
                        return {};
                    },
                };
            },
            batch: async () => {
                batchCalled = true;
                return [];
            },
        };

        await expect(
            updateProduct(db as never, "prod_1", productUpdate),
        ).rejects.toBeInstanceOf(ValidationError);
        expect(batchCalled).toBe(false);
    });

    it("rejects a mixed active default and option SKU topology", async () => {
        let selectCount = 0;
        let batchCalled = false;
        const updateSets: Array<Record<string, unknown>> = [];
        const db = {
            run() { return { kind: "guard" }; },
            select() {
                selectCount++;
                return {
                    from() {
                        return {
                            where() {
                                if (selectCount === 3) {
                                    return Promise.resolve([
                                        {
                                            id: "var_default_prod_1",
                                            isDefault: true,
                                            optionCombinationKey: null,
                                        },
                                        {
                                            id: "var_red",
                                            isDefault: false,
                                            optionCombinationKey: "pval_red",
                                        },
                                    ]);
                                }
                                if (selectCount === 4) return Promise.resolve([]);

                                return {
                                    get: async () => {
                                        if (selectCount === 1) return { id: "prod_1" };
                                        if (selectCount === 2) return null;
                                        return undefined;
                                    },
                                };
                            },
                        };
                    },
                };
            },
            update() {
                return {
                    set(values: Record<string, unknown>) {
                        updateSets.push(values);
                        return {
                            where() {
                                return {
                                    returning() {
                                        return { statement: "update" };
                                    },
                                };
                            },
                        };
                    },
                };
            },
            delete() {
                return {
                    where() {
                        return {};
                    },
                };
            },
            batch: async (statements: unknown[]) => {
                batchCalled = true;
                return statements.map((_, index) =>
                    index === 1 ? [{ aggregateRevision: 2 }] : []
                );
            },
        };

        await expect(updateProduct(db as never, "prod_1", productUpdate))
            .rejects.toBeInstanceOf(ValidationError);
        expect(batchCalled).toBe(false);
        expect(updateSets.some((values) => "size" in values || "color" in values)).toBe(false);
    });

    it("creates an optioned product without an active hidden default SKU", async () => {
        const insertedValues: unknown[] = [];
        const db = {
            select() {
                return {
                    from() {
                        return {
                            where() {
                                return { get: async () => null };
                            },
                        };
                    },
                };
            },
            insert() {
                return {
                    values(values: unknown) {
                        insertedValues.push(values);
                        return { statement: "insert", values };
                    },
                };
            },
            batch: async (statements: unknown[]) => statements.map(() => []),
        };

        await createProduct(db as never, {
            name: "Optioned product",
            description: null,
            price: 250,
            categoryId: "cat_1",
            slug: "optioned-product",
            metaTitle: null,
            metaDescription: null,
            canonicalPath: null,
            noIndex: false,
            excludeFromSitemap: false,
            excludeFromProductFeed: false,
            productCondition: "new",
            isActive: false,
            discountType: "percentage",
            discountPercentage: 0,
            discountAmount: 0,
            freeDelivery: false,
            images: [],
            attributes: [],
            additionalInfo: [],
            optionMatrix: {
                options: [{
                    id: "draft_finish",
                    name: "Finish",
                    standardMapping: "none",
                    values: [{ id: "draft_matte", value: "Matte" }],
                }],
                variants: [{
                    id: "draft_variant",
                    selectedOptionValueIds: ["draft_matte"],
                    imageId: null,
                    sku: "OPTIONED-MATTE",
                    price: 250,
                    stock: 0,
                    trackInventory: true,
                    weight: null,
                    barcode: null,
                    barcodeType: null,
                    discountType: "percentage",
                    discountPercentage: null,
                    discountAmount: null,
                }],
            },
        });

        const variantRows = insertedValues
            .flatMap((value) => Array.isArray(value) ? value : [value])
            .filter((value): value is Record<string, unknown> =>
                Boolean(value) && typeof value === "object" && "isDefault" in value
            );
        expect(variantRows).toHaveLength(1);
        expect(variantRows[0]).toMatchObject({ isDefault: false, sku: "OPTIONED-MATTE" });
    });

    it("repairs active SKU-less product restores with a protected simple SKU", async () => {
        let selectCount = 0;
        const batchStatements: unknown[] = [];
        let defaultSkuInserted = false;

        const db = {
            run() { return { kind: "guard" }; },
            select() {
                selectCount++;
                return {
                    from() {
                        return {
                            where() {
                                return {
                                    get: async () => {
                                        if (selectCount === 1) {
                                            return { id: "prod_1", price: 250, isActive: true };
                                        }
                                        if (selectCount === 2) {
                                            return { count: 0 };
                                        }
                                        return null;
                                    },
                                };
                            },
                        };
                    },
                };
            },
            update() {
                return {
                    set() {
                        return {
                            where() {
                                return {
                                    statement: "update",
                                    returning() {
                                        return { statement: "update" };
                                    },
                                };
                            },
                        };
                    },
                };
            },
            insert() {
                return {
                    values(values: unknown) {
                        defaultSkuInserted = JSON.stringify(values).includes("var_default_prod_1");
                        return { statement: "insert" };
                    },
                };
            },
            batch: async (statements: unknown[]) => {
                batchStatements.push(...statements);
                return statements.map((_, index) =>
                    index === 1 ? [{ aggregateRevision: 2 }] : []
                );
            },
        };

        await restoreProduct(db as never, "prod_1", 1);

        expect(defaultSkuInserted).toBe(true);
        expect(batchStatements).toHaveLength(3);
    });
});
