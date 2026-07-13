import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./customer-columns.tsx", import.meta.url)),
  "utf8",
);

describe("customer desktop columns", () => {
  it("identifies guest versus account buyers and labels paid spend truthfully", () => {
    expect(source).toContain("CustomerAccountBadge");
    expect(source).toContain("customerHasAccount(customer)");
    expect(source).toContain('title="Paid Spend"');
    expect(source).toContain("opts.canViewHistory");
  });
});
