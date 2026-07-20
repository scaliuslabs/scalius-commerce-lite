import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(new URL("./use-config-draft.ts", import.meta.url)),
  "utf8",
);

describe("settings config draft boundary", () => {
  it("preserves unsaved input across query refreshes and browser navigation", () => {
    expect(source).toContain("if (!isDirty)");
    expect(source).toContain('window.addEventListener("beforeunload"');
    expect(source).toContain("setSavedConfig(cloneConfig(value ?? config))");
  });
});
