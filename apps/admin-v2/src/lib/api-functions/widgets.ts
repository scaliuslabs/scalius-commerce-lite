import { createServerFn } from "@tanstack/react-start";
import type {
  DeleteApiV1AdminWidgetsByIdHistoryByVersionIdResponse,
  DeleteApiV1AdminWidgetsByIdPermanentResponse,
  DeleteApiV1AdminWidgetsByIdResponse,
  GetApiV1AdminWidgetsByIdHistoryResponse,
  GetApiV1AdminWidgetsByIdResponse,
  GetApiV1AdminWidgetsData,
  GetApiV1AdminWidgetsPlacementTargetsData,
  GetApiV1AdminWidgetsPlacementTargetsResponse,
  GetApiV1AdminWidgetsResponse,
  PostApiV1AdminWidgetsBulkActivateData,
  PostApiV1AdminWidgetsBulkActivateResponse,
  PostApiV1AdminWidgetsBulkDeactivateData,
  PostApiV1AdminWidgetsBulkDeactivateResponse,
  PostApiV1AdminWidgetsBulkDeleteData,
  PostApiV1AdminWidgetsBulkDeleteResponse,
  PostApiV1AdminWidgetsBulkRestoreData,
  PostApiV1AdminWidgetsBulkRestoreResponse,
  PostApiV1AdminWidgetsByIdHistoryData,
  PostApiV1AdminWidgetsByIdHistoryResponse,
  PostApiV1AdminWidgetsByIdHistoryRestoreData,
  PostApiV1AdminWidgetsByIdHistoryRestoreResponse,
  PostApiV1AdminWidgetsByIdRestoreResponse,
  PostApiV1AdminWidgetsData,
  PostApiV1AdminWidgetsResponse,
  PutApiV1AdminWidgetsByIdData,
  PutApiV1AdminWidgetsByIdResponse,
} from "@scalius/api-client/types";
import { apiDelete, apiGet, apiPost, apiPut } from "../api.server";

type JsonSerializable<T> = T extends Array<infer Item>
  ? JsonSerializable<Item>[]
  : T extends object
    ? {
        [Key in keyof T as string extends Key
          ? never
          : number extends Key
            ? never
            : symbol extends Key
              ? never
              : Key]: JsonSerializable<T[Key]>;
      }
    : T;

type ApiData<T> = T extends { success: true; data: infer Data }
  ? JsonSerializable<Data>
  : never;

type ApiBody<T extends { body?: unknown }> = JsonSerializable<
  NonNullable<T["body"]>
>;

type WidgetListQuery = NonNullable<GetApiV1AdminWidgetsData["query"]>;
type WidgetPlacementTargetsQuery =
  GetApiV1AdminWidgetsPlacementTargetsData["query"];

export interface WidgetsQueryInput extends Omit<WidgetListQuery, "trashed"> {
  [key: string]: string | number | boolean | null | undefined;
  search?: string;
  showTrashed?: boolean;
  trashed?: boolean | "true" | "false";
}

export interface WidgetPlacementTargetsInput
  extends Omit<WidgetPlacementTargetsQuery, "ids"> {
  ids?: string[];
}

export type WidgetListPayload = ApiData<GetApiV1AdminWidgetsResponse>;
export type WidgetListItemDto = WidgetListPayload["widgets"][number];
export type WidgetDetailDto = ApiData<GetApiV1AdminWidgetsByIdResponse>;
export type WidgetPlacementTargetsPayload =
  ApiData<GetApiV1AdminWidgetsPlacementTargetsResponse>;
export type WidgetPlacementTargetDto =
  WidgetPlacementTargetsPayload["targets"][number];
export type CreateWidgetInput = ApiBody<PostApiV1AdminWidgetsData>;
export type UpdateWidgetInput = { id: string } &
  ApiBody<PutApiV1AdminWidgetsByIdData>;
export type WidgetPayload =
  | ApiData<PostApiV1AdminWidgetsResponse>
  | ApiData<PutApiV1AdminWidgetsByIdResponse>;
export type DeleteWidgetPayload = DeleteApiV1AdminWidgetsByIdResponse;
export type PermanentDeleteWidgetPayload =
  DeleteApiV1AdminWidgetsByIdPermanentResponse;
export type RestoreWidgetPayload = PostApiV1AdminWidgetsByIdRestoreResponse;
export type WidgetHistoryEntryDto =
  ApiData<GetApiV1AdminWidgetsByIdHistoryResponse>[number];
export type CreateWidgetHistorySnapshotInput = {
  widgetId: string;
  snapshot: ApiBody<PostApiV1AdminWidgetsByIdHistoryData>;
};
export type CreateWidgetHistorySnapshotPayload =
  ApiData<PostApiV1AdminWidgetsByIdHistoryResponse>;
export type RestoreWidgetHistoryInput = { widgetId: string } &
  ApiBody<PostApiV1AdminWidgetsByIdHistoryRestoreData>;
export type RestoreWidgetHistoryPayload =
  ApiData<PostApiV1AdminWidgetsByIdHistoryRestoreResponse>;
export type DeleteWidgetHistoryInput = {
  widgetId: string;
  historyId: string;
};
export type DeleteWidgetHistoryPayload =
  DeleteApiV1AdminWidgetsByIdHistoryByVersionIdResponse;
export type BulkDeleteWidgetsInput =
  ApiBody<PostApiV1AdminWidgetsBulkDeleteData>;
export type BulkDeleteWidgetsPayload =
  PostApiV1AdminWidgetsBulkDeleteResponse;
export type BulkWidgetIdsInput =
  ApiBody<PostApiV1AdminWidgetsBulkRestoreData>;
export type BulkRestoreWidgetsPayload =
  PostApiV1AdminWidgetsBulkRestoreResponse;
export type BulkActivateWidgetsPayload =
  PostApiV1AdminWidgetsBulkActivateResponse;
export type BulkDeactivateWidgetsPayload =
  PostApiV1AdminWidgetsBulkDeactivateResponse;

function buildWidgetListParams(data: WidgetsQueryInput): Record<string, string> {
  const params: Record<string, string> = {};
  if (data.search) params.search = data.search;
  if (data.showTrashed || data.trashed === true || data.trashed === "true") {
    params.trashed = "true";
  }
  return params;
}

function buildPlacementTargetParams(
  data: WidgetPlacementTargetsInput,
): Record<string, string> {
  const params: Record<string, string> = { type: data.type };
  if (data.search) params.search = data.search;
  if (data.ids?.length) params.ids = data.ids.join(",");
  if (data.limit != null) params.limit = String(data.limit);
  return params;
}

export const getWidgets = createServerFn({ method: "GET" })
  .validator((data: WidgetsQueryInput) => data)
  .handler(async ({ data }) => {
    return apiGet<WidgetListPayload>("/widgets", buildWidgetListParams(data));
  });

export const getWidgetPlacementTargets = createServerFn({ method: "GET" })
  .validator((data: WidgetPlacementTargetsInput) => data)
  .handler(async ({ data }) => {
    return apiGet<WidgetPlacementTargetsPayload>(
      "/widgets/placement-targets",
      buildPlacementTargetParams(data),
    );
  });

export const getWidget = createServerFn({ method: "GET" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<WidgetDetailDto>(`/widgets/${data.id}`);
  });

export const createWidget = createServerFn({ method: "POST" })
  .validator((data: CreateWidgetInput) => data)
  .handler(async ({ data }) => {
    return apiPost<ApiData<PostApiV1AdminWidgetsResponse>>("/widgets", data);
  });

export const updateWidget = createServerFn({ method: "POST" })
  .validator((data: UpdateWidgetInput) => data)
  .handler(async ({ data }) => {
    const { id, ...body } = data;
    return apiPut<ApiData<PutApiV1AdminWidgetsByIdResponse>>(
      `/widgets/${id}`,
      body,
    );
  });

export const deleteWidget = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete<DeleteWidgetPayload>(`/widgets/${data.id}`);
  });

export const permanentDeleteWidget = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete<PermanentDeleteWidgetPayload>(
      `/widgets/${data.id}/permanent`,
    );
  });

export const restoreWidget = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiPost<RestoreWidgetPayload>(`/widgets/${data.id}/restore`);
  });

export const getWidgetHistory = createServerFn({ method: "GET" })
  .validator((data: { widgetId: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<WidgetHistoryEntryDto[]>(
      `/widgets/${data.widgetId}/history`,
    );
  });

export const createWidgetHistorySnapshot = createServerFn({ method: "POST" })
  .validator((data: CreateWidgetHistorySnapshotInput) => data)
  .handler(async ({ data }) => {
    return apiPost<CreateWidgetHistorySnapshotPayload>(
      `/widgets/${data.widgetId}/history`,
      data.snapshot,
    );
  });

export const restoreWidgetHistory = createServerFn({ method: "POST" })
  .validator((data: RestoreWidgetHistoryInput) => data)
  .handler(async ({ data }) => {
    return apiPost<RestoreWidgetHistoryPayload>(
      `/widgets/${data.widgetId}/history/restore`,
      { historyId: data.historyId },
    );
  });

export const deleteWidgetHistory = createServerFn({ method: "POST" })
  .validator((data: DeleteWidgetHistoryInput) => data)
  .handler(async ({ data }) => {
    return apiDelete<DeleteWidgetHistoryPayload>(
      `/widgets/${data.widgetId}/history/${data.historyId}`,
    );
  });

export const bulkDeleteWidgets = createServerFn({ method: "POST" })
  .validator((data: BulkDeleteWidgetsInput) => data)
  .handler(async ({ data }) => {
    return apiPost<BulkDeleteWidgetsPayload>("/widgets/bulk-delete", data);
  });

export const bulkRestoreWidgets = createServerFn({ method: "POST" })
  .validator((data: BulkWidgetIdsInput) => data)
  .handler(async ({ data }) => {
    return apiPost<BulkRestoreWidgetsPayload>("/widgets/bulk-restore", data);
  });

export const bulkActivateWidgets = createServerFn({ method: "POST" })
  .validator((data: ApiBody<PostApiV1AdminWidgetsBulkActivateData>) => data)
  .handler(async ({ data }) => {
    return apiPost<BulkActivateWidgetsPayload>("/widgets/bulk-activate", data);
  });

export const bulkDeactivateWidgets = createServerFn({ method: "POST" })
  .validator(
    (data: ApiBody<PostApiV1AdminWidgetsBulkDeactivateData>) => data,
  )
  .handler(async ({ data }) => {
    return apiPost<BulkDeactivateWidgetsPayload>(
      "/widgets/bulk-deactivate",
      data,
    );
  });
