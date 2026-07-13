import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./index.tsx", import.meta.url)),
  "utf8",
);

describe("customer directory responsive workflow", () => {
  it("uses the intentional mobile buyer card and truthful empty guidance", () => {
    expect(source).toContain("mobileCardRenderer={mobileCardRenderer}");
    expect(source).toContain("<CustomerMobileCard");
    expect(source).toContain("Guest and account buyers appear after checkout");
    expect(source).not.toContain("sync from your orders");
    expect(source).toContain("sm:flex-row sm:items-center sm:justify-between");
  });
});
