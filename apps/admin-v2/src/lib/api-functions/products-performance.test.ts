import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./products.ts", import.meta.url), "utf8");

describe("admin product list request shape", () => {
  it("requests the compact list projection without dropping the public response field", () => {
    expect(source).toContain('const params: Record<string, string> = { view: "compact" }');
    expect(source).toContain("description: string | null");
  });
});
