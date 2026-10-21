// Publishing refuses a draft that draws with apps the storefront would not
// draw (not active, or no longer declaring the part), naming the apps and
// their parts, and publishes it once the apps are there.
import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_STOREFRONT_THEME, type StorefrontThemeDocument } from "@scalius/shared/storefront-theme";
import type { StorefrontExtension } from "@scalius/shared/plugins/storefront-components";
import { getThemeSettings, publishThemeDraft, saveThemeDraft, THEME_APPS_UNAVAILABLE } from "./site-settings.service";

const look: StorefrontExtension = {
  pluginId: "acme.look",
  version: "1.0.0",
  source: "bundled",
  release: "a".repeat(64),
  sections: ["studio_hero"],
  sectionSettings: { studio_hero: [] },
  skins: [{ id: "header_skin", target: "header", settings: [] }],
  components: [],
  islands: [],
  stylesheet: false,
  connect: [],
};
const lookManifest = {
  pluginId: "acme.look",
  manifest: { name: "Look", storefront: { sections: [{ type: "studio_hero", name: "Studio hero" }], skins: [{ id: "header_skin", name: "Look header" }], components: [] } },
};

function themeWithLook(): StorefrontThemeDocument {
  const theme = structuredClone(DEFAULT_STOREFRONT_THEME);
  theme.apps = { skins: { header: { app: "acme.look/header_skin", values: {} } } };
  theme.pages.home = [...theme.pages.home, { id: "studio", type: "app", version: 1, settings: { app: "acme.look/studio_hero", values: {} } }];
  return theme;
}

describe("publishing a theme that draws with apps", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
  });
  afterEach(() => sqlite.close());

  it("refuses while an app is not active, naming it and its parts, and publishes once it is", async () => {
    const theme = themeWithLook();
    const saved = await saveThemeDraft(db, theme, 0, 0, "admin_1");
    const refused = publishThemeDraft(db, 0, saved.revision, "admin_1", null, { extensions: [], installed: [lookManifest] });
    await expect(refused).rejects.toMatchObject({
      status: 400,
      code: THEME_APPS_UNAVAILABLE,
      message: "This theme uses parts of Look, which is not active. Activate Look in Apps, or remove its parts from the theme.",
      details: {
        apps: [{
          pluginId: "acme.look",
          name: "Look",
          reason: "app_inactive",
          parts: [
            { kind: "skin", type: "header_skin", target: "header", path: "apps.skins.header.app", place: { page: "theme" }, name: "Look header" },
            { kind: "section", type: "studio_hero", path: `pages.home.${theme.pages.home.length - 1}.settings.app`, place: { page: "home", index: theme.pages.home.length - 1 }, name: "Studio hero" },
          ],
        }],
        moreParts: 0,
      },
    });
    // Nothing went live.
    await expect(getThemeSettings(db)).resolves.toMatchObject({ revision: 0 });
    // Without the apps the route reads, no app is active: still refused.
    await expect(publishThemeDraft(db, 0, saved.revision)).rejects.toMatchObject({ code: THEME_APPS_UNAVAILABLE });

    await expect(publishThemeDraft(db, 0, saved.revision, "admin_1", null, { extensions: [look], installed: [lookManifest] }))
      .resolves.toMatchObject({ published: { revision: 1 } });
    await expect(getThemeSettings(db)).resolves.toEqual({ theme, revision: 1 });
  });

  it("refuses a part an active app no longer declares", async () => {
    const saved = await saveThemeDraft(db, themeWithLook(), 0, 0);
    const withoutSection = { ...look, sections: [], sectionSettings: {} };
    await expect(publishThemeDraft(db, 0, saved.revision, null, null, { extensions: [withoutSection] })).rejects.toMatchObject({
      code: THEME_APPS_UNAVAILABLE,
      message: "acme.look no longer offers some parts this theme uses. Remove those parts from the theme.",
      details: { apps: [{ pluginId: "acme.look", reason: "not_declared", parts: [expect.objectContaining({ kind: "section", type: "studio_hero" })] }] },
    });
  });
});
