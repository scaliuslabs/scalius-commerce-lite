// An app can never break the store's theme: publishing refuses a draft that
// draws with an app that is not active (naming the app and its parts), and
// succeeds once a Super Admin activates it; the app's page then lists the
// published parts it draws, so turning it off warns what falls back.
import { OpenAPIHono } from "@hono/zod-openapi";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { DEFAULT_STOREFRONT_THEME, type StorefrontThemeDocument } from "@scalius/shared/storefront-theme";
import { errorResponseFromError } from "../../utils/api-response";
import { pluginTestCtx, pluginTestEnv, settleBackground } from "../../plugins/testing/fixtures";
import { adminAppRoutes } from "./apps";
import { siteSettingsRoutes } from "./settings/site";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON from the routes, asserted field by field
type Json = Record<string, any>;

/** The default theme with Noor's header skin and its slideshow section on the homepage. */
function themeWithNoor(): StorefrontThemeDocument {
  const theme = structuredClone(DEFAULT_STOREFRONT_THEME);
  theme.apps = { skins: { header: { app: "scalius.noor/noor_header", values: {} } } };
  theme.pages.home = [{ id: "noor-slides", type: "app", version: 1, settings: { app: "scalius.noor/slideshow", values: {} } }, ...theme.pages.home];
  return theme;
}

describe("theme parts drawn by apps", () => {
  let sqlite: DatabaseSync;
  let app: OpenAPIHono<{ Bindings: Env }>;
  let env: Env;

  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
    const response = await app.request(`/api/v1/admin${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    }, env, pluginTestCtx());
    return { status: response.status, json: await response.json() as Json };
  }

  beforeEach(() => {
    const created = createSqliteD1Database();
    sqlite = created.sqlite;
    env = pluginTestEnv(created.binding);
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
    app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
    app.onError((error, c) => {
      const { body, status } = errorResponseFromError(error);
      return c.json(body, status);
    });
    app.use("*", async (c, next) => {
      c.set("db", created.db);
      c.set("user", { id: "owner", name: "Owner", email: "", isSuperAdmin: true } as never);
      await next();
    });
    app.route("/apps", adminAppRoutes);
    app.route("/settings", siteSettingsRoutes);
  });
  afterEach(async () => {
    await settleBackground();
    sqlite.close();
  });

  it("refuses to publish with an inactive app, publishes once it is active, and lists the parts it draws", async () => {
    await call("GET", "/apps");
    const draft = await call("POST", "/settings/theme/draft", { expectedDraftRevision: 0, basePublishedRevision: 0, theme: themeWithNoor() });
    expect(draft.status).toBe(200);

    const refused = await call("POST", "/settings/theme/publish", { expectedPublishedRevision: 0, expectedDraftRevision: draft.json.data.revision });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toMatchObject({
      code: "theme_apps_unavailable",
      message: "This theme uses parts of Noor theme, which is not active. Activate Noor theme in Apps, or remove its parts from the theme.",
      details: {
        apps: [{
          pluginId: "scalius.noor",
          name: "Noor theme",
          reason: "app_inactive",
          parts: [
            { kind: "skin", type: "noor_header", target: "header", path: "apps.skins.header.app", place: { page: "theme" }, name: "Noor header" },
            { kind: "section", type: "slideshow", path: "pages.home.0.settings.app", place: { page: "home", index: 0 }, name: "Slideshow" },
          ],
        }],
        moreParts: 0,
      },
    });

    // Nothing is published yet, so the app's page lists no parts.
    let noor = (await call("GET", "/apps/scalius.noor")).json.data.app;
    expect(noor.themeUsage).toEqual({ parts: [], more: 0 });
    const activated = await call("POST", "/apps/scalius.noor/activate", { expectedRevision: noor.revision, grantKey: noor.grantKey });
    expect(activated.status).toBe(200);
    noor = activated.json.data.app;

    const published = await call("POST", "/settings/theme/publish", { expectedPublishedRevision: 0, expectedDraftRevision: draft.json.data.revision });
    expect(published.status).toBe(200);

    const usage = (await call("GET", "/apps/scalius.noor")).json.data.app.themeUsage;
    expect(usage).toEqual({
      parts: [
        { kind: "skin", type: "noor_header", target: "header", path: "apps.skins.header.app", place: { page: "theme" }, name: "Noor header" },
        { kind: "section", type: "slideshow", path: "pages.home.0.settings.app", place: { page: "home", index: 0 }, name: "Slideshow" },
      ],
      more: 0,
    });
    // Turning it off answers with the parts that now show the store's own design.
    const stopped = await call("POST", "/apps/scalius.noor/deactivate", { expectedRevision: noor.revision });
    expect(stopped.status).toBe(200);
    expect(stopped.json.data.app).toMatchObject({ status: "disabled", themeUsage: usage });
    // Another app's page names none of Noor's parts.
    expect((await call("GET", "/apps/scalius.bangladesh")).json.data.app.themeUsage).toEqual({ parts: [], more: 0 });
  });
});
