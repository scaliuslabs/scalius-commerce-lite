import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("admin router navigation timing", () => {
  it("keeps the current route visible for the entire navigation", () => {
    const source = readFileSync(new URL("./router.tsx", import.meta.url), "utf8");

    expect(source).toContain("defaultPreload: false");
    expect(source).toContain("defaultPendingMs: Number.POSITIVE_INFINITY");
    expect(source).not.toContain("defaultPendingMinMs");
    expect(source).not.toContain("defaultPendingComponent");
    expect(source).not.toContain("Loading...");
  });
});
