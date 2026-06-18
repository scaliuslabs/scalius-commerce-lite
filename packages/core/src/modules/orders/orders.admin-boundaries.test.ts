import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ORDERS_ADMIN_SOURCE = fileURLToPath(
  new URL("./orders.admin.ts", import.meta.url),
);

describe("admin order list boundaries", () => {
  it("clamps direct API page and limit inputs before building offsets", () => {
    const source = readFileSync(ORDERS_ADMIN_SOURCE, "utf8");

    expect(source).toContain("const MAX_ORDER_LIST_LIMIT = 100");
    expect(source).toContain("function normalizeListPositiveInteger");
    expect(source).toContain("page: rawPage = 1");
    expect(source).toContain("const page = normalizeListPositiveInteger(rawPage, 1)");
    expect(source).toContain(
      "const limit = normalizeListPositiveInteger(rawLimit, 10, MAX_ORDER_LIST_LIMIT)",
    );
    expect(source).toContain("const offset = (page - 1) * limit");
  });

  it("uses API-provided date bounds exactly", () => {
    const source = readFileSync(ORDERS_ADMIN_SOURCE, "utf8");

    expect(source).toContain("const startTs = Math.floor(startDate.getTime() / 1000)");
    expect(source).toContain("const endTs = Math.floor(endDate.getTime() / 1000)");
    expect(source).not.toContain("setHours(23, 59, 59, 999)");
  });

  it("only applies FTS rank ordering when relevance is explicitly requested", () => {
    const source = readFileSync(ORDERS_ADMIN_SOURCE, "utf8");

    expect(source).toContain('type OrderListSort = "relevance"');
    expect(source).toContain("COALESCE(");
    expect(source).toContain("SELECT rank FROM orders_fts");
    expect(source).toContain('if (rankExpression && sort === "relevance")');
    expect(source).toContain("orderBy(...orderByExpressions)");
    expect(source).toContain('case "relevance":');
    expect(source).not.toContain("if (rankExpression) return rankExpression");
  });
});
