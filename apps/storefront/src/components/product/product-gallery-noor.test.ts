// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The store's gallery inside Noor's product page takes Noor's corners, lines
// and photo ground: Noor's stylesheet styles the gallery's own hooks, so each
// hook it names must still be in the gallery's markup.
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("the store's gallery in Noor", () => {
  const gallery = read("./ProductGallery.astro");
  const noor = read("../../../../../plugins/noor/src/storefront.css");

  it.each([
    ["mobile-media-stage", "class"],
    ["thumbnail-btn", "class"],
    ["thumb-ring", "class"],
    ["gallery-list", "class"],
    ["gallery-show-all-label", "class"],
    ["data-image-stage", "attribute"],
    ["data-desktop-image-zoom", "attribute"],
  ])("styles the gallery's %s %s in Noor's tokens", (hook, kind) => {
    expect(gallery).toContain(kind === "class" ? `"${hook}` : hook);
    const rules = noor.split("\n").filter((line) => line.startsWith(".noor-pdp-media") && line.includes(hook));
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.join("\n")).toMatch(/var\(--n-(radius|radius-lg|btn-radius|line|soft)\)/);
  });

  it("rounds photos at Noor's large radius and thumbnails at its small one, never the core radius", () => {
    expect(noor).toMatch(/\.noor-pdp-media :is\(\.mobile-media-stage, \[data-image-stage\], \[data-desktop-image-zoom\], \.gallery-list > li\) \{ border-radius: var\(--n-radius-lg\);/);
    expect(noor).toMatch(/\.noor-pdp-media :is\(\.thumbnail-btn, \.thumb-ring\) \{ border-radius: var\(--n-radius\); \}/);
  });
});
