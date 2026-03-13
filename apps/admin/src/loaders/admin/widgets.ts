import { db } from "@scalius/database/client";
import {
  widgets,
  collections,
  WidgetPlacementRule,
  type Widget,
} from "@scalius/database/schema";
import { eq, isNull, isNotNull, asc, and, like, desc, sql } from "drizzle-orm";
import { unixToDate } from "@scalius/shared/utils";

export async function getWidgetsListPageData(options: {
  search: string;
  showTrashed: boolean;
}) {
  const queryConditions: any[] = [
    options.showTrashed ? isNotNull(widgets.deletedAt) : isNull(widgets.deletedAt),
  ];

  if (options.search) {
    queryConditions.push(like(widgets.name, `%${options.search}%`));
  }

  const widgetsQuery = db
    .select({
      id: widgets.id,
      name: widgets.name,
      htmlContent: widgets.htmlContent,
      cssContent: widgets.cssContent,
      aiContext: widgets.aiContext,
      isActive: widgets.isActive,
      displayTarget: widgets.displayTarget,
      placementRule: widgets.placementRule,
      referenceCollectionId: widgets.referenceCollectionId,
      sortOrder: widgets.sortOrder,
      createdAt: sql<number>`CAST(${widgets.createdAt} AS INTEGER)`,
      updatedAt: sql<number>`CAST(${widgets.updatedAt} AS INTEGER)`,
      deletedAt: sql<number>`CAST(${widgets.deletedAt} AS INTEGER)`,
    })
    .from(widgets)
    .where(and(...queryConditions));

  const dbWidgets = options.showTrashed
    ? await widgetsQuery.orderBy(desc(widgets.deletedAt))
    : await widgetsQuery.orderBy(asc(widgets.sortOrder), asc(widgets.name));

  const mappedWidgets = dbWidgets.map((widget) => {
    const createdAtDate = unixToDate(widget.createdAt);
    const updatedAtDate = unixToDate(widget.updatedAt);
    const deletedAtDate = unixToDate(widget.deletedAt);

    return {
      ...widget,
      createdAt: createdAtDate?.toISOString() ?? null,
      updatedAt: updatedAtDate?.toISOString() ?? null,
      deletedAt: deletedAtDate?.toISOString() ?? null,
    };
  });

  const allCollections = await db
    .select({
      id: collections.id,
      name: collections.name,
      type: collections.type,
      sortOrder: collections.sortOrder,
    })
    .from(collections)
    .where(
      options.showTrashed
        ? and(eq(collections.isActive, true))
        : and(isNull(collections.deletedAt), eq(collections.isActive, true)),
    )
    .orderBy(asc(collections.sortOrder));

  const statsResult = options.showTrashed
    ? { total: 0, active: 0, inactive: 0 }
    : (await db
        .select({
          total: sql<number>`count(*)`,
          active: sql<number>`count(case when is_active = 1 then 1 end)`,
          inactive: sql<number>`count(case when is_active = 0 then 1 end)`,
        })
        .from(widgets)
        .where(isNull(widgets.deletedAt))
        .get()) || { total: 0, active: 0, inactive: 0 };

  return {
    widgets: mappedWidgets,
    collections: allCollections,
    stats: statsResult,
  };
}

export async function getWidgetFormPageData(id: string | undefined) {
  const isCreateMode = id === "create";
  let widgetProp: Widget | null = null;
  let pageTitle = "Create New Widget";
  let submitButtonText = "Create Widget";

  if (!isCreateMode && id) {
    const dbWidget = await db
      .select()
      .from(widgets)
      .where(and(eq(widgets.id, id), isNull(widgets.deletedAt)))
      .get();

    if (dbWidget) {
      pageTitle = `Edit Widget: ${dbWidget.name}`;
      submitButtonText = "Save Changes";

      const createdAt = unixToDate(dbWidget.createdAt);
      const updatedAt = unixToDate(dbWidget.updatedAt);
      const deletedAt = unixToDate(dbWidget.deletedAt);

      widgetProp = {
        ...dbWidget,
        createdAt: createdAt ?? new Date(),
        updatedAt: updatedAt ?? new Date(),
        deletedAt: deletedAt ?? null,
      };
    }
  }

  const availableCollections = await db
    .select({
      id: collections.id,
      name: collections.name,
      type: collections.type,
      sortOrder: collections.sortOrder,
    })
    .from(collections)
    .where(and(isNull(collections.deletedAt), eq(collections.isActive, true)))
    .orderBy(asc(collections.sortOrder));

  return {
    widget: widgetProp,
    isCreateMode,
    pageTitle,
    submitButtonText,
    availableCollections,
    placementRules: Object.values(WidgetPlacementRule),
  };
}
