import { describe, expect, it } from "vitest";
import type { StorefrontExtension } from "../plugins/storefront-components";
import {
  storefrontThemeAppIssues,
  storefrontThemeAppParts,
  storefrontThemeAppProblems,
  storefrontThemeAppReferences,
  type StorefrontThemeAppManifest,
} from "./app-references";
import { DEFAULT_STOREFRONT_THEME, type StorefrontThemeDocument } from "../storefront-theme";

const appSection = (id: string, app: string, hidden?: boolean) =>
  ({ id, type: "app", version: 1, ...(hidden ? { hidden: true } : {}), settings: { app, values: {} } }) as const;
const hero = (id: string, skin?: string) =>
  ({ id, type: "hero", version: 1, settings: { layout: "full-bleed", slides: [] }, ...(skin ? { skin: { app: skin, values: {} } } : {}) }) as const;

/** A theme naming apps in every kind of place. */
function themeWithApps(): StorefrontThemeDocument {
  const theme = structuredClone(DEFAULT_STOREFRONT_THEME);
  theme.apps = { skins: { header: { app: "acme.look/header_skin", values: {} }, footer: { app: "acme.gone/footer_skin", values: {} } } };
  theme.blocks.product = { ...theme.blocks.product, apps: [{ id: "size", app: "acme.look/size_chart", values: {} }] };
  theme.pages.home = [hero("lead", "acme.look/hero_skin"), appSection("studio", "acme.look/studio_hero"), appSection("old", "acme.gone/banner", true)] as never;
  theme.pages.landing = { eid: { title: "Eid", description: "", sections: [appSection("eid-hero", "acme.look/studio_hero")] as never } };
  theme.pages.templates = { ...theme.pages.templates, collection: { sections: [appSection("promo", "acme.look/retired")] as never, main: 0 } };
  return theme;
}

function extension(overrides: Partial<StorefrontExtension> = {}): StorefrontExtension {
  return {
    pluginId: "acme.look",
    version: "1.0.0",
    source: "bundled",
    release: "a".repeat(64),
    sections: ["studio_hero"],
    sectionSettings: { studio_hero: [] },
    skins: [{ id: "header_skin", target: "header", settings: [] }, { id: "hero_skin", target: "section:hero", settings: [] }],
    components: [{ type: "size_chart", targets: ["product.buy_box.after"] as never, settings: [] }],
    islands: [],
    stylesheet: false,
    connect: [],
    ...overrides,
  };
}

describe("storefrontThemeAppReferences", () => {
  it("lists every place the document names an app, with its path and place", () => {
    const references = storefrontThemeAppReferences(themeWithApps());
    expect(references).toEqual([
      { pluginId: "acme.look", type: "header_skin", kind: "skin", target: "header", path: "apps.skins.header.app", place: { page: "theme" } },
      { pluginId: "acme.gone", type: "footer_skin", kind: "skin", target: "footer", path: "apps.skins.footer.app", place: { page: "theme" } },
      { pluginId: "acme.look", type: "size_chart", kind: "product_block", path: "blocks.product.apps.0.app", place: { page: "template", template: "product", index: 0 } },
      { pluginId: "acme.look", type: "hero_skin", kind: "section_skin", target: "section:hero", path: "pages.home.0.skin.app", place: { page: "home", index: 0 } },
      { pluginId: "acme.look", type: "studio_hero", kind: "section", path: "pages.home.1.settings.app", place: { page: "home", index: 1 } },
      { pluginId: "acme.gone", type: "banner", kind: "section", path: "pages.home.2.settings.app", place: { page: "home", index: 2 }, hidden: true },
      { pluginId: "acme.look", type: "studio_hero", kind: "section", path: "pages.landing.eid.sections.0.settings.app", place: { page: "landing", slug: "eid", index: 0 } },
      { pluginId: "acme.look", type: "retired", kind: "section", path: "pages.templates.collection.sections.0.settings.app", place: { page: "template", template: "collection", index: 0 } },
    ]);
  });

  it("finds nothing in a theme without apps", () => {
    expect(storefrontThemeAppReferences(DEFAULT_STOREFRONT_THEME)).toEqual([]);
  });
});

describe("storefrontThemeAppIssues", () => {
  it("reports an app that is not active everywhere it draws (hidden sections never fall back)", () => {
    const issues = storefrontThemeAppIssues(themeWithApps(), [extension()]);
    expect(issues.filter((issue) => issue.pluginId === "acme.gone")).toEqual([
      expect.objectContaining({ kind: "skin", target: "footer", reason: "app_inactive" }),
    ]);
  });

  it("reports the parts an active app no longer declares, by the storefront's rules", () => {
    const issues = storefrontThemeAppIssues(themeWithApps(), [extension()]);
    expect(issues.filter((issue) => issue.pluginId === "acme.look")).toEqual([
      expect.objectContaining({ kind: "section", type: "retired", reason: "not_declared" }),
    ]);
    // A skin declared for another target, a section without its settings, a component outside a product slot.
    const narrowed = extension({
      sectionSettings: {},
      skins: [{ id: "header_skin", target: "footer", settings: [] }, { id: "hero_skin", target: "section:hero", settings: [] }],
      components: [{ type: "size_chart", targets: ["page"] as never, settings: [] }],
    });
    expect(storefrontThemeAppIssues(themeWithApps(), [narrowed]).filter((issue) => issue.pluginId === "acme.look").map((issue) => [issue.path, issue.reason])).toEqual([
      ["apps.skins.header.app", "not_declared"],
      ["blocks.product.apps.0.app", "not_declared"],
      ["pages.home.1.settings.app", "not_declared"],
      ["pages.landing.eid.sections.0.settings.app", "not_declared"],
      ["pages.templates.collection.sections.0.settings.app", "not_declared"],
    ]);
  });

  it("finds nothing once every app draws what the theme names", () => {
    const theme = themeWithApps();
    theme.apps = { skins: { header: { app: "acme.look/header_skin", values: {} } } };
    theme.pages.templates.collection.sections = [];
    expect(storefrontThemeAppIssues(theme, [extension()])).toEqual([]);
    expect(storefrontThemeAppIssues(theme, []).every((issue) => issue.reason === "app_inactive")).toBe(true);
  });
});

describe("named parts", () => {
  const look: StorefrontThemeAppManifest = {
    pluginId: "acme.look",
    manifest: {
      name: "Look",
      storefront: {
        sections: [{ type: "studio_hero", name: "Studio hero" }],
        skins: [{ id: "header_skin", name: "Look header" }, { id: "hero_skin", name: "Look hero" }],
        components: [{ type: "size_chart", name: "Size chart" }],
      },
    },
  };

  it("groups issues by app with the app's names, bounded in all", () => {
    const issues = storefrontThemeAppIssues(themeWithApps(), []);
    const problems = storefrontThemeAppProblems(issues, [look]);
    expect(problems.moreParts).toBe(0);
    expect(problems.apps.map((app) => [app.pluginId, app.name, app.reason, app.parts.length])).toEqual([
      ["acme.look", "Look", "app_inactive", 6],
      ["acme.gone", undefined, "app_inactive", 1],
    ]);
    expect(problems.apps[0]!.parts.slice(0, 3)).toEqual([
      { kind: "skin", type: "header_skin", target: "header", path: "apps.skins.header.app", place: { page: "theme" }, name: "Look header" },
      { kind: "product_block", type: "size_chart", path: "blocks.product.apps.0.app", place: { page: "template", template: "product", index: 0 }, name: "Size chart" },
      { kind: "section_skin", type: "hero_skin", target: "section:hero", path: "pages.home.0.skin.app", place: { page: "home", index: 0 }, name: "Look hero" },
    ]);
    // A part the app no longer declares has no name of its own.
    expect(problems.apps[0]!.parts.at(-1)).not.toHaveProperty("name");
    const bounded = storefrontThemeAppProblems(issues, [look], 2);
    // In document order: the header skin, then the other app's footer skin.
    expect(bounded.apps.map((app) => app.parts.length)).toEqual([1, 1]);
    expect(bounded.moreParts).toBe(5);
  });

  it("names one app's parts for the deactivation warning", () => {
    const references = storefrontThemeAppReferences(themeWithApps()).filter((reference) => reference.pluginId === "acme.look");
    const { parts, more } = storefrontThemeAppParts(references, [look], 4);
    expect(parts.map((part) => part.name)).toEqual(["Look header", "Size chart", "Look hero", "Studio hero"]);
    expect(more).toBe(2);
  });
});
