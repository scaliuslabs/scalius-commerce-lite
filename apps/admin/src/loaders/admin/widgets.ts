import { apiGet } from "@/lib/api-fetch";

// Placement rule values inlined from @scalius/database schema (avoids DB dependency)
const WidgetPlacementRule = {
  BEFORE_COLLECTION: "before_collection",
  AFTER_COLLECTION: "after_collection",
  FIXED_TOP_HOMEPAGE: "fixed_top_homepage",
  FIXED_BOTTOM_HOMEPAGE: "fixed_bottom_homepage",
  STANDALONE: "standalone",
} as const;

export async function getWidgetsListPageData(options: {
  search: string;
  showTrashed: boolean;
}) {
  const params: Record<string, string> = {};
  if (options.search) params.search = options.search;
  if (options.showTrashed) params.trashed = "true";

  // The API listWidgets endpoint returns { widgets, availableCollections }
  // The old loader returned { widgets, collections, stats } with different
  // field names and extra stats computation.
  const result = await apiGet<any>("/widgets", params);

  // Map the API field names to what the admin pages expect
  const widgets = (result.widgets || []).map((widget: any) => ({
    ...widget,
    createdAt: widget.createdAt ? new Date(widget.createdAt).toISOString() : null,
    updatedAt: widget.updatedAt ? new Date(widget.updatedAt).toISOString() : null,
    deletedAt: widget.deletedAt ? new Date(widget.deletedAt).toISOString() : null,
  }));

  const collections = result.availableCollections || result.collections || [];

  // Compute stats from the widget list if not provided by API
  const statsResult = result.stats || {
    total: widgets.length,
    active: widgets.filter((w: any) => w.isActive).length,
    inactive: widgets.filter((w: any) => !w.isActive).length,
  };

  return {
    widgets,
    collections,
    stats: options.showTrashed ? { total: 0, active: 0, inactive: 0 } : statsResult,
  };
}

export async function getWidgetFormPageData(id: string | undefined) {
  const isCreateMode = id === "create";
  let widgetProp: any = null;
  let pageTitle = "Create New Widget";
  let submitButtonText = "Create Widget";

  if (!isCreateMode && id) {
    const dbWidget = await apiGet<any>("/widgets/" + id).catch(() => null);

    if (dbWidget) {
      pageTitle = `Edit Widget: ${dbWidget.name}`;
      submitButtonText = "Save Changes";

      widgetProp = {
        ...dbWidget,
        createdAt: dbWidget.createdAt ? new Date(dbWidget.createdAt) : new Date(),
        updatedAt: dbWidget.updatedAt ? new Date(dbWidget.updatedAt) : new Date(),
        deletedAt: dbWidget.deletedAt ? new Date(dbWidget.deletedAt) : null,
      };
    }
  }

  // Fetch collections from the widgets list endpoint
  const listData = await apiGet<any>("/widgets");
  const availableCollections = listData.availableCollections || listData.collections || [];

  return {
    widget: widgetProp,
    isCreateMode,
    pageTitle,
    submitButtonText,
    availableCollections,
    placementRules: Object.values(WidgetPlacementRule),
  };
}
