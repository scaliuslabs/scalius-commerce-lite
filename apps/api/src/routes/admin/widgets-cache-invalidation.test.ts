import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
  listWidgets: vi.fn(),
  listWidgetPlacementTargets: vi.fn(),
  getWidgetById: vi.fn(),
  createWidget: vi.fn(),
  updateWidget: vi.fn(),
  deleteWidget: vi.fn(),
  bulkDeleteWidgets: vi.fn(),
  bulkActivateWidgets: vi.fn(),
  bulkDeactivateWidgets: vi.fn(),
  restoreWidgets: vi.fn(),
  createHistoryEntry: vi.fn(),
  getWidgetHistory: vi.fn(),
  restoreFromHistory: vi.fn(),
  deleteHistoryEntry: vi.fn(),
  getWidgetCacheSubjects: vi.fn(),
  invalidateApiCachePatterns: vi.fn(),
  resolveCmsShortcodePageTargets: vi.fn(),
  getOptionalExecutionContext: vi.fn((c: { executionCtx?: ExecutionContext }) => {
    try {
      return c.executionCtx;
    } catch {
      return undefined;
    }
  }),
  triggerStorefrontPurgeForPrefixes: vi.fn(),
}));

vi.mock("@scalius/core/modules/widgets", async () => {
  const actual = await vi.importActual<typeof import("@scalius/core/modules/widgets")>(
    "@scalius/core/modules/widgets",
  );
  return {
    ...actual,
    listWidgets: mocks.listWidgets,
    listWidgetPlacementTargets: mocks.listWidgetPlacementTargets,
    getWidgetById: mocks.getWidgetById,
    createWidget: mocks.createWidget,
    updateWidget: mocks.updateWidget,
    deleteWidget: mocks.deleteWidget,
    bulkDeleteWidgets: mocks.bulkDeleteWidgets,
    bulkActivateWidgets: mocks.bulkActivateWidgets,
    bulkDeactivateWidgets: mocks.bulkDeactivateWidgets,
    restoreWidgets: mocks.restoreWidgets,
    createHistoryEntry: mocks.createHistoryEntry,
    getWidgetHistory: mocks.getWidgetHistory,
    restoreFromHistory: mocks.restoreFromHistory,
    deleteHistoryEntry: mocks.deleteHistoryEntry,
    getWidgetCacheSubjects: mocks.getWidgetCacheSubjects,
  };
});

vi.mock("../../utils/cache-invalidation", async () => {
  const actual = await vi.importActual<typeof import("../../utils/cache-invalidation")>(
    "../../utils/cache-invalidation",
  );
  return {
    ...actual,
    invalidateApiCachePatterns: mocks.invalidateApiCachePatterns,
    resolveCmsShortcodePageTargets: mocks.resolveCmsShortcodePageTargets,
    getOptionalExecutionContext: mocks.getOptionalExecutionContext,
    triggerStorefrontPurgeForPrefixes: mocks.triggerStorefrontPurgeForPrefixes,
  };
});

import { adminWidgetRoutes } from "./widgets";

type SubjectPlacement = {
  scope: "homepage" | "page" | "product" | "category" | "collection";
  scopeId?: string | null;
  targetSlug?: string | null;
  isActive?: boolean;
  deletedAt?: Date | null;
};

function subject(
  id: string,
  placements: SubjectPlacement[],
  options: { isActive?: boolean; deletedAt?: Date | null } = {},
) {
  return {
    id,
    isActive: options.isActive ?? true,
    deletedAt: options.deletedAt ?? null,
    placements: placements.map((placement) => ({
      scope: placement.scope,
      scopeId: placement.scopeId ?? null,
      targetSlug: placement.targetSlug ?? null,
      isActive: placement.isActive ?? true,
      deletedAt: placement.deletedAt ?? null,
    })),
  };
}

function createTestApp() {
  const db = { id: "db" };
  const env = {
    CACHE: { id: "api-cache-kv" },
    PURGE_URL: "https://storefront.example.com/api/purge-cache",
    PURGE_TOKEN: "secret-token",
  } as unknown as Env;
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");

  mocks.invalidateApiCachePatterns.mockResolvedValue(undefined);
  mocks.resolveCmsShortcodePageTargets.mockResolvedValue([]);
  mocks.createWidget.mockResolvedValue({ id: "wid_new" });
  mocks.updateWidget.mockResolvedValue({ id: "wid_1" });

  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  app.route("/admin/widgets", adminWidgetRoutes);
  return { app, db, env };
}

describe("admin widget cache invalidation", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("invalidates only old and new scoped widget prefixes when placement scope changes", async () => {
    const { app, db, env } = createTestApp();
    mocks.getWidgetCacheSubjects
      .mockResolvedValueOnce([
        subject("wid_1", [
          { scope: "category", scopeId: "cat_1", targetSlug: "shirts" },
        ]),
      ])
      .mockResolvedValueOnce([
        subject("wid_1", [
          { scope: "product", scopeId: "prod_1", targetSlug: "black-shirt" },
        ]),
      ]);

    const response = await app.request(
      "/api/v1/admin/widgets/wid_1",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          placements: [
            {
              scope: "product",
              scopeId: "prod_1",
              slot: "top",
              isActive: true,
            },
          ],
        }),
      },
      env,
    );

    expect(response.status).toBe(200);
    expect(mocks.getWidgetCacheSubjects).toHaveBeenNthCalledWith(
      1,
      db,
      ["wid_1"],
      { includeDeleted: true },
    );
    expect(mocks.getWidgetCacheSubjects).toHaveBeenNthCalledWith(2, db, ["wid_1"]);
    expect(mocks.invalidateApiCachePatterns).toHaveBeenCalledWith(
      ["api:widgets:single:/api/v1/widgets/wid_1*"],
      env.CACHE,
    );

    const [prefixes, purgeEnv, options, executionCtx] =
      mocks.triggerStorefrontPurgeForPrefixes.mock.calls[0]!;
    expect(prefixes).toEqual(
      expect.arrayContaining([
        "widget_wid_1",
        "widgets_scope_category_cat_1",
        "widgets_scope_product_prod_1",
      ]),
    );
    expect(prefixes).not.toEqual(
      expect.arrayContaining([
        "global_homepage_widgets",
        "storefront_homepage_",
        "page_render_",
        "product_slug_",
        "category_slug_",
        "collection_by_id_",
      ]),
    );
    expect(purgeEnv).toBe(env);
    expect(options).toEqual({
      groups: ["widgets"],
      bumpVersion: false,
      htmlPaths: expect.arrayContaining([
        "/categories/shirts",
        "/products/black-shirt",
      ]),
    });
    expect(executionCtx).toBeUndefined();
  });

  it("warms homepage only for homepage widget placements", async () => {
    const { app, env } = createTestApp();
    mocks.createWidget.mockResolvedValue({ id: "wid_home" });
    mocks.getWidgetCacheSubjects.mockResolvedValueOnce([
      subject("wid_home", [{ scope: "homepage" }]),
    ]);

    const response = await app.request(
      "/api/v1/admin/widgets",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Homepage Widget",
          htmlContent: "<section>Promo</section>",
          isActive: true,
          placements: [{ scope: "homepage", slot: "top", isActive: true }],
        }),
      },
      env,
    );

    expect(response.status).toBe(201);
    expect(mocks.invalidateApiCachePatterns).toHaveBeenCalledWith(
      [
        "api:widgets:single:/api/v1/widgets/wid_home*",
        "api:widgets:active-homepage:*",
        "api:storefront:homepage:*",
      ],
      env.CACHE,
    );

    const [prefixes, , options] = mocks.triggerStorefrontPurgeForPrefixes.mock.calls[0]!;
    expect(prefixes).toEqual(
      expect.arrayContaining([
        "widget_wid_home",
        "global_homepage_widgets",
        "widgets_scope_homepage_global",
        "storefront_homepage_",
      ]),
    );
    expect(options).toEqual({ groups: ["widgets"], bumpVersion: true });
  });

  it("purges exact page render caches for page-scoped placements with known slugs", async () => {
    const { app, env } = createTestApp();
    mocks.createWidget.mockResolvedValue({ id: "wid_page" });
    mocks.getWidgetCacheSubjects.mockResolvedValueOnce([
      subject("wid_page", [
        { scope: "page", scopeId: "page_1", targetSlug: "about-us" },
      ]),
    ]);

    const response = await app.request(
      "/api/v1/admin/widgets",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Page Widget",
          htmlContent: "<section>Page copy</section>",
          isActive: true,
          placements: [
            {
              scope: "page",
              scopeId: "page_1",
              slot: "before_content",
              isActive: true,
            },
          ],
        }),
      },
      env,
    );

    expect(response.status).toBe(201);
    expect(mocks.invalidateApiCachePatterns).toHaveBeenCalledWith(
      [
        "api:widgets:single:/api/v1/widgets/wid_page*",
        "api:storefront:page:/api/v1/storefront/pages/slug/about-us*",
      ],
      env.CACHE,
    );

    const [prefixes, , options] = mocks.triggerStorefrontPurgeForPrefixes.mock.calls[0]!;
    expect(prefixes).toEqual(
      expect.arrayContaining([
        "widget_wid_page",
        "widgets_scope_page_page_1",
        "page_render_about-us_",
      ]),
    );
    expect(options).toEqual({
      groups: ["widgets"],
      bumpVersion: false,
      htmlPaths: ["/about-us"],
    });
  });

  it("purges CMS pages that reference active widget shortcodes without placements", async () => {
    const { app, db, env } = createTestApp();
    mocks.createWidget.mockResolvedValue({ id: "wid_shortcode" });
    mocks.getWidgetCacheSubjects.mockResolvedValueOnce([
      subject("wid_shortcode", []),
    ]);
    mocks.resolveCmsShortcodePageTargets.mockResolvedValueOnce([
      { id: "page_1", slug: "combo-offer" },
    ]);

    const response = await app.request(
      "/api/v1/admin/widgets",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Shortcode Widget",
          htmlContent: "<section>Shortcode copy</section>",
          isActive: true,
          placements: [],
        }),
      },
      env,
    );

    expect(response.status).toBe(201);
    expect(mocks.resolveCmsShortcodePageTargets).toHaveBeenCalledWith(db, {
      widgetIds: ["wid_shortcode"],
    });
    expect(mocks.invalidateApiCachePatterns).toHaveBeenCalledWith(
      [
        "api:widgets:single:/api/v1/widgets/wid_shortcode*",
        "api:storefront:page:/api/v1/storefront/pages/slug/combo-offer*",
      ],
      env.CACHE,
    );

    const [prefixes, , options] = mocks.triggerStorefrontPurgeForPrefixes.mock.calls[0]!;
    expect(prefixes).toEqual([
      "widget_wid_shortcode",
      "page_render_combo-offer_",
    ]);
    expect(options).toEqual({
      groups: ["widgets"],
      bumpVersion: false,
      htmlPaths: ["/combo-offer"],
    });
  });

  it("purges exact collection HTML caches for collection-scoped placements", async () => {
    const { app, env } = createTestApp();
    mocks.createWidget.mockResolvedValue({ id: "wid_collection" });
    mocks.getWidgetCacheSubjects.mockResolvedValueOnce([
      subject("wid_collection", [
        { scope: "collection", scopeId: "col_1" },
      ]),
    ]);

    const response = await app.request(
      "/api/v1/admin/widgets",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Collection Widget",
          htmlContent: "<section>Collection copy</section>",
          isActive: true,
          placements: [
            {
              scope: "collection",
              scopeId: "col_1",
              slot: "top",
              isActive: true,
            },
          ],
        }),
      },
      env,
    );

    expect(response.status).toBe(201);

    const [prefixes, , options] = mocks.triggerStorefrontPurgeForPrefixes.mock.calls[0]!;
    expect(prefixes).toEqual(
      expect.arrayContaining([
        "widget_wid_collection",
        "widgets_scope_collection_col_1",
      ]),
    );
    expect(options).toEqual({
      groups: ["widgets"],
      bumpVersion: false,
      htmlPaths: ["/collections/col_1"],
    });
  });

  it("does not purge storefront caches for inactive-only widget creates", async () => {
    const { app, env } = createTestApp();
    mocks.createWidget.mockResolvedValue({ id: "wid_inactive" });
    mocks.getWidgetCacheSubjects.mockResolvedValueOnce([
      subject(
        "wid_inactive",
        [{ scope: "product", scopeId: "prod_1", targetSlug: "black-shirt" }],
        { isActive: false },
      ),
    ]);

    const response = await app.request(
      "/api/v1/admin/widgets",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Inactive Widget",
          htmlContent: "<section>Draft</section>",
          isActive: false,
          placements: [
            {
              scope: "product",
              scopeId: "prod_1",
              slot: "top",
              isActive: true,
            },
          ],
        }),
      },
      env,
    );

    expect(response.status).toBe(201);
    expect(mocks.resolveCmsShortcodePageTargets).not.toHaveBeenCalled();
    expect(mocks.invalidateApiCachePatterns).not.toHaveBeenCalled();
    expect(mocks.triggerStorefrontPurgeForPrefixes).not.toHaveBeenCalled();
  });
});
