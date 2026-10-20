import { describe, expect, it } from "vitest";
import { DEFAULT_STOREFRONT_THEME, type StorefrontThemeDocument } from "@scalius/shared/storefront-theme";
import type { ThemeApp } from "~/lib/api-query-options/online-store";
import { appBlocksByKey, appSkinsByKey } from "../theme-settings";
import { appSectionsByKey } from "./editor-state";
import { draftPartOf, saveableDraft, type DraftApps } from "./saveable-draft";

type Theme = StorefrontThemeDocument;

const STUDIO: ThemeApp = {
  id: "acme.studio",
  name: "Acme Studio",
  sections: [],
  templates: [], pagePresets: [],
  components: [],
  skins: [{
    key: "acme.studio/header", id: "header", target: "header", name: "Studio header", description: null,
    settings: [{ key: "tagline", label: "Tagline", help: null, type: "text", required: true, options: null, default: null, min: null, max: null, integer: false, maxLength: 20 }],
  }],
};
const APPS: DraftApps = { sections: appSectionsByKey([STUDIO]), blocks: appBlocksByKey([STUDIO]), skins: appSkinsByKey([STUDIO]) };
const withApps = (apps: Theme["apps"], theme: Theme = DEFAULT_STOREFRONT_THEME): Theme => ({ ...theme, apps });

describe("app skins in autosave", () => {
  it("names a skin's part from its document path", () => {
    expect(draftPartOf(DEFAULT_STOREFRONT_THEME, ["apps", "skins", "header", "values", "tagline"])).toBe("skin:header");
    expect(draftPartOf(DEFAULT_STOREFRONT_THEME, ["apps", "template"])).toBe("apps");
    expect(draftPartOf(DEFAULT_STOREFRONT_THEME, ["apps"])).toBe("apps");
  });

  it("saves a skin whose values the app accepts", () => {
    const working = withApps({ skins: { header: { app: "acme.studio/header", values: { tagline: "Eid" } } } });
    expect(saveableDraft(working, DEFAULT_STOREFRONT_THEME, APPS)).toEqual({ theme: working, held: [] });
  });

  it("holds back only the skin the app would refuse, keeping its saved value", () => {
    const saved = withApps({ skins: { header: { app: "acme.studio/header", values: { tagline: "Eid" } } }, template: "acme.studio/bold" });
    const colors = { ...saved.tokens.colors, primary: "#111111" };
    const working = withApps({ ...saved.apps, skins: { header: { app: "acme.studio/header", values: { tagline: "x".repeat(21) } } } }, { ...saved, tokens: { ...saved.tokens, colors } });
    expect(saveableDraft(working, saved, APPS)).toEqual({ theme: { ...working, apps: saved.apps }, held: ["skin:header"] });
    // A newly chosen skin that is not valid yet waits; the theme saves without it.
    const fresh = withApps({ skins: { header: { app: "acme.studio/header", values: {} } } });
    expect(saveableDraft(fresh, DEFAULT_STOREFRONT_THEME, APPS)).toEqual({ theme: DEFAULT_STOREFRONT_THEME, held: ["skin:header"] });
  });

  it("never judges a skin whose app is not active", () => {
    const working = withApps({ skins: { footer: { app: "acme.gone/footer", values: { anything: "kept" } } } });
    expect(saveableDraft(working, DEFAULT_STOREFRONT_THEME, APPS)).toEqual({ theme: working, held: [] });
  });
});
