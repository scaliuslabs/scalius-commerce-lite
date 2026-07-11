import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  new URL("./products.admin.ts", import.meta.url),
  "utf8",
);

describe("admin product timestamp boundaries", () => {
  it("normalizes Drizzle Date values and Unix timestamps without multiplying dates twice", () => {
    expect(SOURCE).toContain(
      'import { unixToDate } from "@scalius/shared/timestamps"',
    );
    expect(SOURCE).toContain(
      'requireProductTimestamp(result.updatedAt, "updated timestamp")',
    );
    expect(SOURCE).not.toContain(
      "new Date(Number(result.updatedAt) * 1000)",
    );
    expect(SOURCE).not.toContain("new Date(product.updatedAt * 1000)");
  });
});
