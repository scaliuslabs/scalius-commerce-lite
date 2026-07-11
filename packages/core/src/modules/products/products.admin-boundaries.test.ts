import { describe, expect, it } from "vitest";
import { ValidationError } from "@scalius/core/errors";
import { restoreProduct, updateProduct } from "./products.admin";

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
    variantOption1Label: "Option 1",
    variantOption2Label: "Option 2",
    variantOption1Schema: "size" as const,
    variantOption2Schema: "color" as const,
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

    it("repairs legacy default SKU option labels during product updates", async () => {
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
                                            size: "Default",
                                            color: "Default",
                                        },
                                        {
                                            id: "var_red",
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

        await updateProduct(db as never, "prod_1", productUpdate);

        expect(batchCalled).toBe(true);
        expect(updateSets).toContainEqual(expect.objectContaining({
            size: null,
            color: null,
        }));
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
