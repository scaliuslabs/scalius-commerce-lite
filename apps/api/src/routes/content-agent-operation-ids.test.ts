import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import { articleRoutes } from "./articles";
import { heroRoutes } from "./hero";
import { navigationRoutes } from "./navigation";
import { pagesRoutes } from "./pages";
import { adminMediaRoutes } from "./admin/media";
import { adminNavigationRoutes } from "./admin/navigation";
import { adminPageRoutes } from "./admin/pages";
import { heroSlidersRoutes } from "./admin/settings/hero-sliders";
import { siteSettingsRoutes } from "./admin/settings/site";
import {
  contentAgentScenarios,
  contentPresentationOnlyScenarios,
} from "./content-agent-scenarios.fixture";

type Operation = { operationId?: string };
type Spec = { paths?: Record<string, Record<string, Operation>> };
type Expected = readonly [method: string, path: string, operationId: string];

function buildSpec(): Spec {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.route("/pages", pagesRoutes);
  app.route("/articles", articleRoutes);
  app.route("/navigation", navigationRoutes);
  app.route("/hero", heroRoutes);
  app.route("/admin/pages", adminPageRoutes);
  app.route("/admin/media", adminMediaRoutes);
  app.route("/admin/navigation", adminNavigationRoutes);
  app.route("/admin/settings", siteSettingsRoutes);
  app.route("/admin/settings/hero-sliders", heroSlidersRoutes);
  return app.getOpenAPIDocument({
    openapi: "3.0.0",
    info: { title: "Content parity", version: "test" },
  }) as unknown as Spec;
}

const expectedOperations: Expected[] = [
  ["get", "/api/v1/admin/pages", "dashboard.content.list"],
  ["post", "/api/v1/admin/pages", "dashboard.content.create"],
  ["post", "/api/v1/admin/pages/bulk-delete", "dashboard.content.bulk_delete"],
  ["post", "/api/v1/admin/pages/bulk-publish", "dashboard.content.bulk_publish"],
  ["post", "/api/v1/admin/pages/bulk-unpublish", "dashboard.content.bulk_unpublish"],
  ["post", "/api/v1/admin/pages/bulk-restore", "dashboard.content.bulk_restore"],
  ["get", "/api/v1/admin/pages/{id}", "dashboard.content.get"],
  ["put", "/api/v1/admin/pages/{id}", "dashboard.content.update"],
  ["delete", "/api/v1/admin/pages/{id}", "dashboard.content.trash"],
  ["post", "/api/v1/admin/pages/{id}/restore", "dashboard.content.restore"],
  ["delete", "/api/v1/admin/pages/{id}/permanent", "dashboard.content.permanently_delete"],
  ["get", "/api/v1/admin/media", "dashboard.media.list"],
  ["post", "/api/v1/admin/media/uploads", "dashboard.media.upload_initiate"],
  ["post", "/api/v1/admin/media/uploads/import-url", "dashboard.media.import_url"],
  ["get", "/api/v1/admin/media/uploads/{id}", "dashboard.media.upload_get"],
  ["delete", "/api/v1/admin/media/uploads/{id}", "dashboard.media.upload_abort"],
  ["put", "/api/v1/admin/media/uploads/{id}/parts/{partNumber}", "dashboard.media.upload_part"],
  ["post", "/api/v1/admin/media/uploads/{id}/complete", "dashboard.media.upload_complete"],
  ["post", "/api/v1/admin/media/uploads/reconcile", "dashboard.media.upload_reconcile"],
  ["patch", "/api/v1/admin/media/{id}", "dashboard.media.update"],
  ["post", "/api/v1/admin/media/{id}/trash", "dashboard.media.trash"],
  ["post", "/api/v1/admin/media/{id}/restore", "dashboard.media.restore"],
  ["delete", "/api/v1/admin/media/{id}/permanent", "dashboard.media.permanently_delete"],
  ["post", "/api/v1/admin/media/move", "dashboard.media.move"],
  ["get", "/api/v1/admin/media/folders", "dashboard.media_folders.list"],
  ["post", "/api/v1/admin/media/folders", "dashboard.media_folders.create"],
  ["put", "/api/v1/admin/media/folders/{id}", "dashboard.media_folders.update"],
  ["delete", "/api/v1/admin/media/folders/{id}", "dashboard.media_folders.delete"],
  ["get", "/api/v1/admin/navigation/items", "dashboard.navigation.legacy_items_list"],
  ["get", "/api/v1/admin/navigation/resources", "dashboard.navigation.resources_search"],
  ["get", "/api/v1/admin/navigation/preview-products", "dashboard.navigation.products_preview_count"],
  ["get", "/api/v1/admin/navigation/menus", "dashboard.navigation.menus_list"],
  ["post", "/api/v1/admin/navigation/menus", "dashboard.navigation.menus_create"],
  ["get", "/api/v1/admin/navigation/menus/{menuId}", "dashboard.navigation.menus_get"],
  ["patch", "/api/v1/admin/navigation/menus/{menuId}", "dashboard.navigation.menus_update"],
  ["delete", "/api/v1/admin/navigation/menus/{menuId}", "dashboard.navigation.menus_trash"],
  ["post", "/api/v1/admin/navigation/menus/{menuId}/restore", "dashboard.navigation.menus_restore"],
  ["get", "/api/v1/admin/navigation/menus/{menuId}/items", "dashboard.navigation.items_list"],
  ["post", "/api/v1/admin/navigation/menus/{menuId}/items", "dashboard.navigation.items_create"],
  ["get", "/api/v1/admin/navigation/menus/{menuId}/search", "dashboard.navigation.items_search"],
  ["get", "/api/v1/admin/navigation/menus/{menuId}/items/{itemId}", "dashboard.navigation.items_get"],
  ["patch", "/api/v1/admin/navigation/menus/{menuId}/items/{itemId}", "dashboard.navigation.items_update"],
  ["delete", "/api/v1/admin/navigation/menus/{menuId}/items/{itemId}", "dashboard.navigation.items_delete"],
  ["get", "/api/v1/admin/navigation/menus/{menuId}/items/{itemId}/move-options", "dashboard.navigation.items_move_options"],
  ["post", "/api/v1/admin/navigation/menus/{menuId}/items/{itemId}/move", "dashboard.navigation.items_move"],
  ["post", "/api/v1/admin/navigation/menus/{menuId}/publish", "dashboard.navigation.menus_publish"],
  ["get", "/api/v1/admin/navigation/menus/{menuId}/publications", "dashboard.navigation.publications_list"],
  ["post", "/api/v1/admin/navigation/menus/{menuId}/rollback", "dashboard.navigation.menus_rollback"],
  ["get", "/api/v1/admin/navigation/placements", "dashboard.navigation.placements_manifest"],
  ["get", "/api/v1/admin/navigation/placement-settings", "dashboard.navigation.placements_list"],
  ["put", "/api/v1/admin/navigation/placements/{placementId}", "dashboard.navigation.placements_save"],
  ["get", "/api/v1/admin/navigation/authority-shadow", "dashboard.navigation.authority_shadow"],
  ["get", "/api/v1/admin/settings/theme", "dashboard.theme.get"],
  ["post", "/api/v1/admin/settings/theme", "dashboard.theme.save_legacy"],
  ["get", "/api/v1/admin/settings/theme/workspace", "dashboard.theme.workspace_get"],
  ["post", "/api/v1/admin/settings/theme/draft", "dashboard.theme.draft_save"],
  ["post", "/api/v1/admin/settings/theme/draft/rebase", "dashboard.theme.draft_rebase"],
  ["post", "/api/v1/admin/settings/theme/publish", "dashboard.theme.publish"],
  ["get", "/api/v1/admin/settings/theme/versions", "dashboard.theme.versions_list"],
  ["post", "/api/v1/admin/settings/theme/rollback", "dashboard.theme.rollback"],
  ["post", "/api/v1/admin/settings/theme/preview-session", "dashboard.theme.preview_session_create"],
  ["get", "/api/v1/admin/settings/hero-sliders", "dashboard.hero_sliders.list"],
  ["post", "/api/v1/admin/settings/hero-sliders", "dashboard.hero_sliders.create"],
  ["get", "/api/v1/admin/settings/hero-sliders/{id}", "dashboard.hero_sliders.get"],
  ["put", "/api/v1/admin/settings/hero-sliders/{id}", "dashboard.hero_sliders.update"],
  ["delete", "/api/v1/admin/settings/hero-sliders/{id}", "dashboard.hero_sliders.trash"],
  ["get", "/api/v1/pages", "storefront.pages.list"],
  ["get", "/api/v1/pages/slug/{slug}", "storefront.pages.get_by_slug"],
  ["get", "/api/v1/pages/{id}", "storefront.pages.get_by_id"],
  ["get", "/api/v1/articles", "storefront.articles.list"],
  ["get", "/api/v1/articles/slug/{slug}", "storefront.articles.get_by_slug"],
  ["get", "/api/v1/navigation", "storefront.navigation.get"],
  ["get", "/api/v1/navigation/placements", "storefront.navigation.placements_list"],
  ["get", "/api/v1/navigation/menus/{menuId}", "storefront.navigation.menu_get"],
  ["get", "/api/v1/navigation/menus/{menuId}/items", "storefront.navigation.items_list"],
  ["get", "/api/v1/navigation/{id}", "storefront.navigation.menu_get_by_id"],
  ["get", "/api/v1/hero/sliders", "storefront.hero_sliders.list"],
  ["get", "/api/v1/hero/sliders/{id}", "storefront.hero_sliders.get"],
];

describe("content operation identity", () => {
  it("publishes one stable, surface-qualified ID for every content parity route", () => {
    const spec = buildSpec();
    const ids = new Set<string>();
    for (const [method, path, operationId] of expectedOperations) {
      const operation = spec.paths?.[path]?.[method];
      expect(operation?.operationId, `${method.toUpperCase()} ${path}`).toBe(operationId);
      expect(operationId).toMatch(/^(dashboard|storefront)(\.[a-z][a-z0-9_]*){2,}$/);
      expect(ids.has(operationId), `duplicate ${operationId}`).toBe(false);
      ids.add(operationId);
    }
  });

  it("classifies every operation in one backend scenario without duplicate authority", () => {
    const routedIds = new Set(expectedOperations.map((entry) => entry[2]));
    const scenarioIds = Object.values(contentAgentScenarios).flat();
    expect(new Set(scenarioIds).size).toBe(scenarioIds.length);
    expect(new Set(scenarioIds)).toEqual(routedIds);
    expect(contentPresentationOnlyScenarios.length).toBeGreaterThan(0);
  });
});
