import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("admin router navigation timing", () => {
  it("does not force a pending screen onto sub-400ms route changes", () => {
    const source = readFileSync(new URL("./router.tsx", import.meta.url), "utf8");

    expect(source).toContain("defaultPreload: false");
    expect(source).toContain("defaultPendingMs: 400");
    expect(source).toContain("defaultPendingMinMs: 100");
  });
});
