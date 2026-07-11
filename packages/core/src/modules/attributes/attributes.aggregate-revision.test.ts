import { describe, expect, it } from "vitest";
import { productAttributes, products } from "@scalius/database/schema";
import { permanentlyDeleteAttribute } from "./attributes.service";

describe("attribute product aggregate cascades", () => {
    it("evaluates affected products inside the same batch as attribute deletion", async () => {
        const batchCalls: unknown[][] = [];
        const db = {
            update(table: unknown) {
                return {
                    set() {
                        return {
                            where() {
                                return { kind: "revision", table };
                            },
                        };
                    },
                };
            },
            delete(table: unknown) {
                return {
                    where() {
                        return { kind: "delete", table };
                    },
                };
            },
            async batch(statements: unknown[]) {
                batchCalls.push(statements);
                return statements.map(() => []);
            },
        };

        await permanentlyDeleteAttribute(db as never, "attr_1");

        expect(batchCalls).toHaveLength(1);
        expect(batchCalls[0]).toHaveLength(2);
        expect(batchCalls[0]?.[0]).toEqual({ kind: "revision", table: products });
        expect(batchCalls[0]?.[1]).toEqual({
            kind: "delete",
            table: productAttributes,
        });
    });
});
