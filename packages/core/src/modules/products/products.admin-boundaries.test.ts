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
    isActive: true,
    discountType: "percentage" as const,
    discountPercentage: 0,
    discountAmount: 0,
    freeDelivery: false,
    images: [],
    attributes: [],
    additionalInfo: [],
};

describe("admin product SKU invariant boundaries", () => {
    it("fails product updates when a non-default SKU has no customer option", async () => {
        let selectCount = 0;
        let batchCalled = false;
        const db = {
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
                                return {};
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

    it("repairs active SKU-less product restores with a protected simple SKU", async () => {
        let selectCount = 0;
        const batchStatements: unknown[] = [];
        let defaultSkuInserted = false;

        const db = {
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
                                return { statement: "update" };
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
                return [];
            },
        };

        await restoreProduct(db as never, "prod_1");

        expect(defaultSkuInserted).toBe(true);
        expect(batchStatements).toHaveLength(2);
    });
});
