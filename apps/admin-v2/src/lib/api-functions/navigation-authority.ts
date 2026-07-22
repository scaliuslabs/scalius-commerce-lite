import { createServerFn } from "@tanstack/react-start";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from "../api.server";

export type NavigationTargetType =
  | "label"
  | "system"
  | "page"
  | "category"
  | "collection"
  | "product"
  | "internal_path"
  | "external_url";

export interface NavigationMenuSummary {
  id: string;
  name: string;
  handle: string;
  revision: number;
  publishedRevision: number | null;
  dependencyRevision: number;
  updatedAt: string | number;
  deletedAt: string | number | null;
  itemCount: number;
  placementCount: number;
}

export interface NavigationMenuItemRow {
  id: string;
  menuId: string;
  parentId: string | null;
  position: number;
  label: string;
  labelMode: "custom" | "resource";
  targetType: NavigationTargetType;
  targetId: string | null;
  targetValue: string | null;
  targetQuery: string | null;
  openInNewTab: boolean;
  isEnabled: boolean;
  createdAt: string | number;
  updatedAt: string | number;
}

export interface NavigationMenuItemPage {
  items: Array<{ item: NavigationMenuItemRow; childCount: number }>;
  nextCursor: string | null;
}

export interface NavigationMenuMoveOptions {
  item: { id: string; label: string; parentId: string | null };
  subtreeDepth: number;
  currentPosition: number;
  selectedParentId: string | null;
  positionCount: number;
  parents: Array<{
    id: string;
    label: string;
    pathLabel: string;
    resultingLevel: number;
    childCount: number;
  }>;
}

export interface NavigationPlacementSetting {
  placement: {
    id: string;
    surface: string;
    slot: string;
    position: number;
    menuId: string;
    labelOverride: string | null;
    isEnabled: boolean;
    revision: number;
  };
  menuName: string;
  menuDeletedAt: string | number | null;
  publishedRevision: number | null;
  publicationItemCount: number | null;
}

export interface NavigationPublication {
  menuId: string;
  revision: number;
  publishedAt: string | number;
  publishedBy: string | null;
  itemCount: number;
  checksum: string;
}

export type NavigationResourceType = "page" | "category" | "collection" | "product";

export interface NavigationResourceOption {
  id: string;
  name: string;
  type: NavigationResourceType;
  url: string;
  available: boolean;
}

export interface NavigationResourcePage {
  items: NavigationResourceOption[];
  selected: NavigationResourceOption | null;
  nextCursor: string | null;
}

export interface NavigationItemDraft {
  label: string;
  labelMode: "custom" | "resource";
  target:
    | { type: "resource"; resourceType: "page" | "category" | "collection" | "product"; resourceId: string; query?: string }
    | { type: "system"; key: "home" | "catalog" | "search" | "account" | "cart" | "checkout" | "order_lookup" }
    | { type: "internal_path"; path: string }
    | { type: "external_url"; url: string }
    | { type: "label" };
  openInNewTab?: boolean;
  isEnabled?: boolean;
}

export const getNavigationMenusAuthority = createServerFn({ method: "GET" })
  .validator((data: { cursor?: string; limit?: number; includeTrash?: boolean } = {}) => data)
  .handler(async ({ data }) => apiGet<{
    items: NavigationMenuSummary[];
    nextCursor: string | null;
  }>("/navigation/menus", {
    limit: String(data.limit ?? 50),
    ...(data.cursor ? { cursor: data.cursor } : {}),
    ...(data.includeTrash ? { includeTrash: "true" } : {}),
  }));

export const getNavigationResourcesAuthority = createServerFn({ method: "GET" })
  .validator((data: {
    type: NavigationResourceType;
    query?: string;
    cursor?: string;
    limit?: number;
    selectedId?: string;
  }) => data)
  .handler(async ({ data }) => apiGet<NavigationResourcePage>(
    "/navigation/resources",
    {
      type: data.type,
      q: data.query?.trim() ?? "",
      limit: String(data.limit ?? 20),
      ...(data.cursor ? { cursor: data.cursor } : {}),
      ...(data.selectedId ? { selectedId: data.selectedId } : {}),
    },
  ));

export const getNavigationMenuAuthority = createServerFn({ method: "GET" })
  .validator((data: { menuId: string }) => data)
  .handler(async ({ data }) => apiGet<{ menu: NavigationMenuSummary }>(
    `/navigation/menus/${encodeURIComponent(data.menuId)}`,
  ));

export const getNavigationMenuItemPage = createServerFn({ method: "GET" })
  .validator((data: { menuId: string; parentId?: string | null; cursor?: string; limit?: number }) => data)
  .handler(async ({ data }) => apiGet<NavigationMenuItemPage>(
    `/navigation/menus/${encodeURIComponent(data.menuId)}/items`,
    {
      limit: String(data.limit ?? 100),
      ...(data.parentId ? { parentId: data.parentId } : {}),
      ...(data.cursor ? { cursor: data.cursor } : {}),
    },
  ));

export const searchNavigationMenuItemsAuthority = createServerFn({ method: "GET" })
  .validator((data: { menuId: string; query: string; limit?: number }) => data)
  .handler(async ({ data }) => apiGet<{
    items: Array<{ item: NavigationMenuItemRow; childCount: number; isMatch: boolean }>;
  }>(`/navigation/menus/${encodeURIComponent(data.menuId)}/search`, {
    q: data.query,
    limit: String(data.limit ?? 50),
  }));

export const getNavigationMenuItemAuthority = createServerFn({ method: "GET" })
  .validator((data: { menuId: string; itemId: string }) => data)
  .handler(async ({ data }) => apiGet<{
    item: NavigationMenuItemRow;
    childCount: number;
  }>(
    `/navigation/menus/${encodeURIComponent(data.menuId)}/items/${encodeURIComponent(data.itemId)}`,
  ));

export const getNavigationMenuMoveOptionsAuthority = createServerFn({ method: "GET" })
  .validator((data: {
    menuId: string;
    itemId: string;
    query?: string;
    limit?: number;
    selectedParentId?: string | null;
  }) => data)
  .handler(async ({ data }) => apiGet<NavigationMenuMoveOptions>(
    `/navigation/menus/${encodeURIComponent(data.menuId)}/items/${encodeURIComponent(data.itemId)}/move-options`,
    {
      limit: String(data.limit ?? 50),
      ...(data.query ? { q: data.query } : {}),
      ...(data.selectedParentId === null
        ? { topLevel: "true" }
        : data.selectedParentId
          ? { parentId: data.selectedParentId }
          : {}),
    },
  ));

export const createNavigationMenuAuthority = createServerFn({ method: "POST" })
  .validator((data: { name: string; handle?: string }) => data)
  .handler(async ({ data }) => apiPost<{ menu: NavigationMenuSummary }>(
    "/navigation/menus",
    data,
  ));

export const updateNavigationMenuMetadataAuthority = createServerFn({ method: "POST" })
  .validator((data: {
    menuId: string;
    expectedRevision: number;
    name: string;
    handle: string;
  }) => data)
  .handler(async ({ data }) => {
    const { menuId, ...body } = data;
    return apiPatch<{ revision: number; name: string; handle: string }>(
      `/navigation/menus/${encodeURIComponent(menuId)}`,
      body,
    );
  });

export const trashNavigationMenuAuthority = createServerFn({ method: "POST" })
  .validator((data: { menuId: string; expectedRevision: number }) => data)
  .handler(async ({ data }) => apiDelete<{ revision: number }>(
    `/navigation/menus/${encodeURIComponent(data.menuId)}`,
    {
    expectedRevision: data.expectedRevision,
    },
  ));

export const restoreNavigationMenuAuthority = createServerFn({ method: "POST" })
  .validator((data: { menuId: string; expectedRevision: number }) => data)
  .handler(async ({ data }) => apiPost<{ revision: number }>(
    `/navigation/menus/${encodeURIComponent(data.menuId)}/restore`,
    { expectedRevision: data.expectedRevision },
  ));

export const createNavigationMenuItemAuthority = createServerFn({ method: "POST" })
  .validator((data: NavigationItemDraft & {
    menuId: string;
    expectedRevision: number;
    parentId?: string | null;
  }) => data)
  .handler(async ({ data }) => {
    const { menuId, ...body } = data;
    return apiPost<{ item: NavigationMenuItemRow; revision: number }>(
      `/navigation/menus/${encodeURIComponent(menuId)}/items`,
      body,
    );
  });

export const updateNavigationMenuItemAuthority = createServerFn({ method: "POST" })
  .validator((data: NavigationItemDraft & {
    menuId: string;
    itemId: string;
    expectedRevision: number;
  }) => data)
  .handler(async ({ data }) => {
    const { menuId, itemId, ...body } = data;
    return apiPatch<{ item: NavigationMenuItemRow; revision: number }>(
      `/navigation/menus/${encodeURIComponent(menuId)}/items/${encodeURIComponent(itemId)}`,
      body,
    );
  });

export const moveNavigationMenuItemAuthority = createServerFn({ method: "POST" })
  .validator((data: {
    menuId: string;
    itemId: string;
    expectedRevision: number;
    parentId?: string | null;
    beforeId?: string;
    afterId?: string;
    index?: number;
  }) => data)
  .handler(async ({ data }) => {
    const { menuId, itemId, ...body } = data;
    return apiPost<{ revision: number }>(
      `/navigation/menus/${encodeURIComponent(menuId)}/items/${encodeURIComponent(itemId)}/move`,
      body,
    );
  });

export const deleteNavigationMenuItemAuthority = createServerFn({ method: "POST" })
  .validator((data: { menuId: string; itemId: string; expectedRevision: number }) => data)
  .handler(async ({ data }) => apiDelete<{ deletedCount: number; revision: number }>(
    `/navigation/menus/${encodeURIComponent(data.menuId)}/items/${encodeURIComponent(data.itemId)}`,
    { expectedRevision: data.expectedRevision },
  ));

export const publishNavigationMenuAuthority = createServerFn({ method: "POST" })
  .validator((data: { menuId: string; expectedRevision: number }) => data)
  .handler(async ({ data }) => apiPost<{
    revision: number;
    publishedRevision: number;
    itemCount: number;
    checksum: string;
  }>(`/navigation/menus/${encodeURIComponent(data.menuId)}/publish`, {
    expectedRevision: data.expectedRevision,
  }));

export const getNavigationPublications = createServerFn({ method: "GET" })
  .validator((data: { menuId: string; cursor?: number; limit?: number }) => data)
  .handler(async ({ data }) => apiGet<{
    items: NavigationPublication[];
    nextCursor: number | null;
  }>(`/navigation/menus/${encodeURIComponent(data.menuId)}/publications`, {
    limit: String(data.limit ?? 20),
    ...(data.cursor ? { cursor: String(data.cursor) } : {}),
  }));

export const rollbackNavigationMenuAuthority = createServerFn({ method: "POST" })
  .validator((data: { menuId: string; expectedRevision: number; sourceRevision: number }) => data)
  .handler(async ({ data }) => apiPost<{
    revision: number;
    publishedRevision: number;
    sourceRevision: number;
    itemCount: number;
    checksum: string;
  }>(`/navigation/menus/${encodeURIComponent(data.menuId)}/rollback`, {
    expectedRevision: data.expectedRevision,
    sourceRevision: data.sourceRevision,
  }));

export const getNavigationPlacementSettings = createServerFn({ method: "GET" })
  .handler(async () => apiGet<{ placements: NavigationPlacementSetting[] }>(
    "/navigation/placement-settings",
  ));

export const saveNavigationPlacementAuthority = createServerFn({ method: "POST" })
  .validator((data: {
    placementId: string;
    expectedRevision: number;
    surface: string;
    slot: string;
    position: number;
    menuId: string;
    labelOverride?: string | null;
    isEnabled?: boolean;
  }) => data)
  .handler(async ({ data }) => {
    const { placementId, ...body } = data;
    return apiPut<{ placement: NavigationPlacementSetting["placement"] }>(
      `/navigation/placements/${encodeURIComponent(placementId)}`,
      body,
    );
  });
