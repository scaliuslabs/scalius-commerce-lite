import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConflictError } from "@scalius/core/errors";
import { bulkDeleteAttributes } from "./attributes.service";

describe("attribute delete integrity", () => {
    const source = readFileSync(new URL("./attributes.service.ts", import.meta.url), "utf8");

    it("routes single and bulk deletes through one guarded primitive", () => {
        expect(source).toContain("await deleteAttributes(db, [id], false)");
        expect(source).toContain("await deleteAttributes(db, ids, permanent)");
        expect(source).toContain("attributeDeleteGuard(db, ids, permanent)");
        expect(source).toContain("await safeBatch(db, [attributeDeleteGuard");
    });

    it("requires trash state and no product values before permanent deletion", () => {
        expect(source).toContain("Move attributes to trash before permanently deleting them.");
        expect(source).toContain("AND NOT EXISTS (");
        expect(source).toContain("FROM ${productAttributeValues}");
        expect(source).toContain("const idSet = JSON.stringify(ids)");
        expect(source).toContain("FROM json_each(${idSet})");
    });

    it("uses a single JSON lookup bind for large admin attribute pages", () => {
        expect(source).toContain("FROM json_each(${attributeIdsJson})");
        expect(source).not.toContain(".where(inArray(productAttributeValues.attributeId, attributeIds))");
    });

    it("blocks bulk trash when any selected attribute is still assigned", async () => {
        let batchCalled = false;
        const db = {
            select() {
                return {
                    from() {
                        return {
                            where() {
                                return Promise.resolve([{ id: "attr_1", deletedAt: null }]);
                            },
                            leftJoin() {
                                return {
                                    where: () => ({
                                        limit: async () => [{ productId: "prod_1", productName: "Example" }],
                                    }),
                                };
                            },
                        };
                    },
                };
            },
            async batch() {
                batchCalled = true;
                return [];
            },
        };

        await expect(
            bulkDeleteAttributes(db as never, ["attr_1"], false),
        ).rejects.toBeInstanceOf(ConflictError);
        expect(batchCalled).toBe(false);
    });

    it("fails closed when an assignment appears after the preflight read", async () => {
        let selectCount = 0;
        const db = {
            select() {
                selectCount++;
                return {
                    from() {
                        if (selectCount === 3) return { kind: "guard" };
                        return {
                            where() {
                                return Promise.resolve([{ id: "attr_1", deletedAt: null }]);
                            },
                            leftJoin() {
                                return {
                                    where: () => ({ limit: async () => [] }),
                                };
                            },
                        };
                    },
                };
            },
            update() {
                return { set: () => ({ where: () => ({ kind: "update" }) }) };
            },
            async batch() {
                throw new Error("D1_ERROR: malformed JSON");
            },
        };

        await expect(
            bulkDeleteAttributes(db as never, ["attr_1"], false),
        ).rejects.toBeInstanceOf(ConflictError);
    });
});
