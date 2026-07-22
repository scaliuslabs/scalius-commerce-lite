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
const floatingLayerSources = [
  "alert-dialog.tsx",
  "dialog.tsx",
  "dropdown-menu.tsx",
  "sheet.tsx",
  "tooltip.tsx",
].map((fileName) => ({
  fileName,
  source: readFileSync(
    fileURLToPath(new URL(`./${fileName}`, import.meta.url)),
    "utf8",
  ),
}));

describe("floating-layer state boundaries", () => {
  it("cannot leave a popover invisible, visible, or interactive based on animation progress", () => {
    expect(source).toContain("data-[state=closed]:invisible");
    expect(source).toContain("data-[state=closed]:pointer-events-none");
    expect(source).not.toContain("animate-");
  });

  it("applies the same fail-safe to select menus", () => {
    expect(selectSource).toContain("data-[state=closed]:invisible");
    expect(selectSource).toContain("data-[state=closed]:pointer-events-none");
    expect(selectSource).not.toContain("animate-");
  });

  it.each(floatingLayerSources)(
    "keeps $fileName state independent of animations",
    ({ source: floatingLayerSource }) => {
      expect(floatingLayerSource).toContain("data-[state=closed]:invisible");
      expect(floatingLayerSource).toContain(
        "data-[state=closed]:pointer-events-none",
      );
      expect(floatingLayerSource).not.toContain("animate-");
    },
  );
});
