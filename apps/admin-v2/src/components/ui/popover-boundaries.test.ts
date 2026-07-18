import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./popover.tsx", import.meta.url)),
  "utf8",
);
const selectSource = readFileSync(
  fileURLToPath(new URL("./select.tsx", import.meta.url)),
  "utf8",
);

describe("popover closed-state boundary", () => {
  it("cannot leave a closed portal visible or interactive when exit animation stalls", () => {
    expect(source).toContain("data-[state=closed]:invisible");
    expect(source).toContain("data-[state=closed]:pointer-events-none");
    expect(source).not.toContain("data-[state=closed]:animate-out");
  });

  it("applies the same fail-safe to select menus", () => {
    expect(selectSource).toContain("data-[state=closed]:invisible");
    expect(selectSource).toContain("data-[state=closed]:pointer-events-none");
    expect(selectSource).not.toContain("data-[state=closed]:animate-out");
  });
});
