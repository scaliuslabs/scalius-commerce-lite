import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("widget generation run route boundaries", () => {
  it("does not statically import the Cloudflare agents runtime", () => {
    const source = readFileSync(
      join(import.meta.dirname, "widget-generation-runs.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/from\s+["']agents["']/);
    expect(source).toContain('await import("agents")');
  });
});
