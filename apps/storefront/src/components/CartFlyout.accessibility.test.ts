import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./CartFlyout.tsx", import.meta.url)),
  "utf8",
);

describe("CartFlyout accessibility contract", () => {
  it("gives the Radix sheet an accessible description", () => {
    expect(source).toContain("SheetDescription");
    expect(source).toMatch(
      /<SheetContent[\s\S]*?<SheetDescription className="sr-only">[\s\S]*?Review cart items, change quantities, or continue to checkout\.[\s\S]*?<\/SheetDescription>[\s\S]*?<\/SheetContent>/,
    );
  });
});
