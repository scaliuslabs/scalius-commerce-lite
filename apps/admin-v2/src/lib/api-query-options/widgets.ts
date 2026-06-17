import { queryOptions } from "@tanstack/react-query";
import {
  getWidget,
  getWidgetHistory,
  getWidgets,
  type WidgetsQueryInput,
} from "../api-functions/widgets";
import { queryKeys } from "../query-keys";

const MODERATE_STALE_TIME_MS = 1000 * 60 * 2;
const SLOW_STALE_TIME_MS = 1000 * 60 * 5;

export const widgetsQueryOptions = (params: WidgetsQueryInput) =>
  queryOptions({
    queryKey: queryKeys.widgets.list(params),
    queryFn: () => getWidgets({ data: params }),
    staleTime: MODERATE_STALE_TIME_MS,
  });

export const widgetQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.widgets.detail(id),
    queryFn: () => getWidget({ data: { id } }),
    staleTime: 0,
  });

export const widgetHistoryQueryOptions = (widgetId: string) =>
  queryOptions({
    queryKey: queryKeys.widgets.history(widgetId),
    queryFn: () => getWidgetHistory({ data: { widgetId } }),
    staleTime: SLOW_STALE_TIME_MS,
  });
