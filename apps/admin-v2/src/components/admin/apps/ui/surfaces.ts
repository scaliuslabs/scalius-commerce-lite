// Where active apps appear in the dashboard (packages/plugin-sdk/docs/apps.md,
// "Admin surfaces"): their pages in the navigation, cards on resource detail
// pages, actions on detail pages and bulk bars, and widgets on Home. One
// cached read (`GET /api/v1/admin/apps/surfaces`) serves them all, and only
// for staff who may view apps. This module stays light (no UI schema, no
// renderer) because the shell and every list page import it.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePermissions } from "~/contexts/PermissionContext";
import { useLocale } from "~/i18n";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { localizedSurfaces } from "../app-text";
import { appSurfacesQueryOptions, type AppAdminSurfaces } from "~/lib/api-query-options/apps";
import type { AppRouteMethod } from "~/lib/app-route";
import type { PluginUiTarget } from "@scalius/shared/plugins/ui";

export type AppSurfaces = AppAdminSurfaces;
export type AppPage = AppSurfaces["pages"][number];
export type AppCard = AppSurfaces["cards"][number];
export type AppAction = AppSurfaces["actions"][number];
export type AppWidget = AppSurfaces["widgets"][number];
/** A resource an app attaches cards or actions to. */
export type AppTarget = AppCard["target"];
export type AppPlacement = AppPage["placement"];

/** Scalius resources with a dashboard detail page (what a link can open). */
export type AppLinkResource = "product" | "order" | "customer" | "category" | "collection" | "brand" | "page";

const NONE: readonly AppSurfaces[] = [];

/** Whether the app declares this admin route with this method (anything else is never called). */
export function isAppRouteDeclared(app: Pick<AppSurfaces, "routes">, route: string, method: AppRouteMethod): boolean {
  return app.routes.some((entry) => entry.name === route && (entry.methods as readonly string[]).includes(method));
}

/** The dashboard path of one app page. */
export function appPagePath(pluginId: string, pageId: string): string {
  return `/admin/apps/${encodeURIComponent(pluginId)}/pages/${encodeURIComponent(pageId)}`;
}

/** A resource's detail page. */
export function resourcePath(resource: AppLinkResource, id: string): string {
  const key = encodeURIComponent(id);
  switch (resource) {
    case "product":
      return `/admin/products/${key}/edit`;
    case "order":
      return `/admin/orders/${key}`;
    case "customer":
      return `/admin/customers/${key}/edit`;
    case "category":
      return `/admin/categories/${key}/edit`;
    case "collection":
      return `/admin/collections/${key}/edit`;
    case "brand":
      return `/admin/brands/${key}/edit`;
    case "page":
      return `/admin/pages/${key}/edit`;
  }
}

/** Where a link from an app goes: a dashboard route, or an https site in a new tab. */
export type AppTargetLocation =
  | { kind: "internal"; to: string; search?: Record<string, string> }
  | { kind: "external"; href: string };

/**
 * Resolves an app's link target (already validated by the UI schema): only
 * this app's own pages, Scalius resource pages, or https sites.
 */
export function targetLocation(app: Pick<AppSurfaces, "id">, target: PluginUiTarget): AppTargetLocation | null {
  switch (target.kind) {
    case "app-page":
      return { kind: "internal", to: appPagePath(app.id, target.page), ...(target.query ? { search: { ...target.query } } : {}) };
    case "resource":
      return { kind: "internal", to: resourcePath(target.resource, target.id) };
    case "external":
      // The schema allows only https; checked again because a link must never run script.
      return /^https:\/\//i.test(target.href) ? { kind: "external", href: target.href } : null;
    default:
      return null;
  }
}

/**
 * Every active app's surfaces, titled in the dashboard's language; empty
 * without apps.view, while loading, or when the read failed.
 */
export function useAppSurfaces(): readonly AppSurfaces[] {
  const { hasPermission } = usePermissions();
  const canView = hasPermission(ADMIN_PERMISSIONS.APPS_VIEW);
  const locale = useLocale();
  const { data } = useQuery({ ...appSurfacesQueryOptions(), enabled: canView });
  return useMemo(
    () => (canView && data ? data.map((app) => localizedSurfaces(app, locale)) : NONE),
    [canView, data, locale],
  );
}

/** Staff may run apps' actions (buttons, forms, detail and bulk actions). */
export function useCanUseApps(): boolean {
  const { hasPermission } = usePermissions();
  return hasPermission(ADMIN_PERMISSIONS.APPS_VIEW) && hasPermission(ADMIN_PERMISSIONS.APPS_USE);
}

/** The cards apps show on one resource's detail page, in app order. */
export function useAppCards(target: AppTarget): Array<{ app: AppSurfaces; card: AppCard }> {
  const apps = useAppSurfaces();
  return useMemo(
    () => apps.flatMap((app) => app.cards
      .filter((card) => card.target === target && isAppRouteDeclared(app, card.route, "GET"))
      .map((card) => ({ app, card }))),
    [apps, target],
  );
}

/**
 * The actions staff can run on a resource: `bulk: false` ones on its detail
 * page, `bulk: true` ones on its list's bulk bar (the manifest's "detail page
 * or bulk bar"). Empty without apps.use.
 */
export function useAppActions(target: AppTarget, bulk: boolean): Array<{ app: AppSurfaces; action: AppAction }> {
  const apps = useAppSurfaces();
  const canUse = useCanUseApps();
  return useMemo(
    () => (canUse
      ? apps.flatMap((app) => app.actions
        .filter((action) => action.target === target && action.bulk === bulk && isAppRouteDeclared(app, action.route, "POST"))
        .map((action) => ({ app, action })))
      : []),
    [apps, bulk, canUse, target],
  );
}

/** Home widgets of every active app. */
export function useAppWidgets(): Array<{ app: AppSurfaces; widget: AppWidget }> {
  const apps = useAppSurfaces();
  return useMemo(
    () => apps.flatMap((app) => app.widgets
      .filter((widget) => isAppRouteDeclared(app, widget.route, "GET"))
      .map((widget) => ({ app, widget }))),
    [apps],
  );
}

/** One app page as the navigation lists it. */
export interface AppNavPage {
  placement: AppPlacement;
  title: string;
  to: string;
}

/**
 * Active apps' pages for the navigation. The shell calls it above the
 * permission context, so it takes the apps.view decision itself.
 */
export function useAppNavPages(canView: boolean): readonly AppNavPage[] {
  const { data } = useQuery({ ...appSurfacesQueryOptions(), enabled: canView });
  return useMemo(
    () => (canView && data
      ? data.flatMap((app) => app.pages.map((page) => ({ placement: page.placement, title: page.title, to: appPagePath(app.id, page.id) })))
      : []),
    [canView, data],
  );
}
