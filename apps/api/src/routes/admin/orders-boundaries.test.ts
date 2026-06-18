import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ADMIN_ORDERS_ROUTE_SOURCE = fileURLToPath(
    new URL("./orders.ts", import.meta.url),
);

describe("admin orders route boundaries", () => {
    it("keeps relevance as an explicit order-list search sort mode", () => {
        const source = readFileSync(ADMIN_ORDERS_ROUTE_SOURCE, "utf8");

        expect(source).toContain('type OrderListSort = "relevance"');
        expect(source).toContain('z.enum([');
        expect(source).toContain('"relevance"');
        expect(source).toContain('"updatedAt"');
        expect(source).toContain("const effectiveSort: OrderListSort = query.sort");
        expect(source).toContain('?? (query.search?.trim() ? "relevance" : "updatedAt")');
        expect(source).toContain("sort: effectiveSort");
    });
});
