// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { STOREFRONT_TYPE_PAIRINGS } from "@scalius/shared/storefront-theme";
import { previewFamily, typePairingPreview } from "./theme-settings";

class FakeFontFace {
  constructor(
    readonly family: string,
    readonly source: string,
    readonly descriptors: FontFaceDescriptors,
  ) {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("type preview fonts", () => {
  it("registers every pairing's faces once, under preview names, from self-hosted woff2 files", async () => {
    const added: FakeFontFace[] = [];
    vi.stubGlobal("FontFace", FakeFontFace);
    Object.defineProperty(document, "fonts", { configurable: true, value: { add: (face: FakeFontFace) => added.push(face) } });
    const { registerTypePreviewFonts } = await import("./type-preview-fonts");

    registerTypePreviewFonts();
    registerTypePreviewFonts();

    const families = new Set(added.map((face) => face.family));
    // Latin and Bengali faces of every pairing, and nothing that shadows the dashboard's own fonts.
    for (const pairing of STOREFRONT_TYPE_PAIRINGS) {
      const preview = typePairingPreview(pairing);
      for (const family of [preview.heading.family, preview.body.family, preview.bangla]) {
        expect(families).toContain(previewFamily(family));
      }
    }
    expect([...families].every((family) => family.startsWith(previewFamily("")))).toBe(true);
    // Registered once: six Latin families, Noto Sans and Serif Bengali, and Hind Siliguri's two cuts.
    expect(added).toHaveLength(10);
    for (const face of added) {
      expect(face.source).toMatch(/^url\(".+\.woff2"\) format\("woff2"\)$/);
      expect(face.source).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
      expect(face.descriptors.display).toBe("swap");
      expect(face.descriptors.unicodeRange).toBeTruthy();
    }
    // Bangla faces leave the Taka sign (U+09F3) to the system font, as the storefront does.
    const bengali = added.filter((face) => face.family === previewFamily("Noto Serif Bengali"));
    expect(bengali[0]!.descriptors.unicodeRange).toContain("U+0980-09F2,U+09F4-09FE");
  });

  it("does nothing where the browser has no font loading API", async () => {
    vi.stubGlobal("FontFace", undefined);
    const { registerTypePreviewFonts } = await import("./type-preview-fonts");
    expect(() => registerTypePreviewFonts()).not.toThrow();
  });
});
