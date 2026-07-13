import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manager = readFileSync(new URL("./MediaManager.tsx", import.meta.url), "utf8");

describe("MediaManager picker selection boundary", () => {
  it("does not turn a single picker into toggle mode when it has a current value", () => {
    expect(manager).toContain("manager.setSelectionMode(!!onSelectMultiple)");
    expect(manager).not.toContain("!!onSelectMultiple || selectedFiles.length > 0");
  });
});
