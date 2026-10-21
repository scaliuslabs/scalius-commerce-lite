import { describe, expect, it } from "vitest";
import type { StorefrontSection } from "@scalius/shared/storefront-theme";
import type { ThemeApp } from "~/lib/api-query-options/online-store";
import { appSkinsByKey, sectionSkinInvalid, withSectionSkin } from "./theme-settings";

const strip = { id: "usp-1", type: "usp_strip", settings: {} } as unknown as StorefrontSection;
const app = {
  id: "acme.skin",
  name: "Acme Skin",
  skins: [{ key: "acme.skin/bold", target: "section:usp_strip", name: "Bold", settings: [{ key: "accent", type: "color", label: "Accent", required: true }] }],
} as unknown as ThemeApp;

describe("a core section's app skin", () => {
  it("is set on the section and taken off without leaving a key", () => {
    const skinned = withSectionSkin(strip, () => ({ app: "acme.skin/bold", values: { accent: "#d9480f" } }));
    expect((skinned as { skin?: unknown }).skin).toEqual({ app: "acme.skin/bold", values: { accent: "#d9480f" } });
    const back = withSectionSkin(skinned, () => null);
    expect("skin" in back).toBe(false);
  });

  it("holds back values its app rejects, and never judges an inactive app's skin", () => {
    const byKey = appSkinsByKey([app]);
    expect(sectionSkinInvalid(withSectionSkin(strip, () => ({ app: "acme.skin/bold", values: { accent: "#d9480f" } })), byKey)).toBe(false);
    expect(sectionSkinInvalid(withSectionSkin(strip, () => ({ app: "acme.skin/bold", values: {} })), byKey)).toBe(true);
    expect(sectionSkinInvalid(withSectionSkin(strip, () => ({ app: "gone.app/x", values: {} })), byKey)).toBe(false);
  });
});
