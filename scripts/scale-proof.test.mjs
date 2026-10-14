import { describe, expect, it } from "vitest";
import { docBlock, parseArgs, renderResults, replaceDocBlock } from "./scale-proof.mjs";

const d1 = {
  provider: "d1",
  engine: "D1 (Miniflare)",
  store: { orders: 1_000_000, orderItems: 2_000_000, products: 50_000, skus: 150_000, customers: 200_000 },
  reads: [{ name: "product page", status: 200, p50: 12, p95: 30, rowsRead: 400 }],
  checkout: [{ scenario: "3 lines over many SKUs", clients: 16, orders: 100, ordersPerSecond: 8.04, p50: 90, p95: 300, failures: {}, retries: null }],
  perOrder: { rowsRead: 900, rowsWritten: 214 },
};
const pg = {
  provider: "postgres",
  engine: "PostgreSQL 15",
  store: d1.store,
  reads: [{ name: "product page", status: 500, p50: 2, p95: 3, rowsRead: 0 }],
  checkout: [{ scenario: "1 hot SKU", clients: 16, orders: 20, ordersPerSecond: 3, p50: 80, p95: 200, failures: { 500: 4 }, retries: 37 }],
  perOrder: { rowsRead: 5000, rowsWritten: 47 },
};

describe("scale proof arguments", () => {
  it("needs an absolute state directory outside the repository", () => {
    expect(() => parseArgs([])).toThrow("--state");
    expect(() => parseArgs(["--state", "relative/dir"])).toThrow("absolute");
    expect(parseArgs(["--state", "/tmp/scale", "--providers", "d1", "--orders", "40", "--write-doc"])).toMatchObject({ providers: ["d1"], orders: 40, writeDoc: true, seed: false });
    expect(() => parseArgs(["--state", "/tmp/scale", "--providers", "mysql"])).toThrow("--providers");
    expect(() => parseArgs(["--state", "/tmp/scale", "--orders", "2"])).toThrow("--orders");
    expect(() => parseArgs(["--state", "/tmp/scale", "--nope"])).toThrow("Unknown option");
  });
});

describe("scale proof tables", () => {
  it("puts every engine's reads, checkout runs and per-order rows beside each other, failures included", () => {
    const text = renderResults([d1, pg]);
    expect(text).toContain("1,000,000 orders");
    expect(text).toContain("| product page | 12 | 30 | 400 | 2 (HTTP 500) | 3 | 0 |");
    expect(text).toContain("| postgres | 1 hot SKU | 16 | 20 | 3.0 | 80 | 200 | 4 (HTTP 500) | 37 |");
    expect(text).toContain("| d1 | 3 lines over many SKUs | 16 | 100 | 8.0 | 90 | 300 | 0 | n/a |");
    expect(text).toContain("| d1 | 900 | 214 |");
  });

  it("replaces only the marked block of the document", () => {
    const meta = { date: "2026-10-14", commit: "abc1234", machine: "test machine" };
    const doc = "# Scale\n\nbefore\n\n<!-- scale-proof:start -->\nold\n<!-- scale-proof:end -->\n\nafter\n";
    const next = replaceDocBlock(doc, docBlock([d1], meta));
    expect(next).toContain("before");
    expect(next).toContain("after");
    expect(next).not.toContain("\nold\n");
    expect(next).toContain("Measured 2026-10-14 at commit `abc1234` on test machine.");
    expect(() => replaceDocBlock("no markers", "x")).toThrow("block");
  });
});
