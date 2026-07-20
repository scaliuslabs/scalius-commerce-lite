import { createServerFn } from "@tanstack/react-start";
import type {
  GetApiV1AdminPromotionsByIdResponse,
  GetApiV1AdminPromotionsData,
  GetApiV1AdminPromotionsResponse,
  PostApiV1AdminPromotionsByIdActivateResponse,
  PostApiV1AdminPromotionsByIdPauseResponse,
  PostApiV1AdminPromotionsByIdPreviewData,
  PostApiV1AdminPromotionsByIdPreviewResponse,
  PostApiV1AdminPromotionsData,
  PostApiV1AdminPromotionsResponse,
  PutApiV1AdminPromotionsByIdData,
  PutApiV1AdminPromotionsByIdResponse,
} from "@scalius/api-client/types";

import { apiDelete, apiGet, apiPost, apiPut } from "../api.server";

type JsonValue = null | boolean | number | string | JsonValue[] | {
  [key: string]: JsonValue;
};

type JsonSerializable<T> = unknown extends T
  ? JsonValue
  : T extends Array<infer Item>
    ? JsonSerializable<Item>[]
    : T extends object
      ? string extends keyof T
        ? { [key: string]: JsonValue }
        : {
            [Key in keyof T as number extends Key
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

type PromotionListQuery = NonNullable<GetApiV1AdminPromotionsData["query"]>;

export interface PromotionsQueryInput
  extends Omit<PromotionListQuery, "includeDeleted"> {
  [key: string]: number | boolean | undefined;
  includeDeleted?: boolean;
}

export type PromotionsListPayload = ApiData<GetApiV1AdminPromotionsResponse>;
export type PromotionAggregate = ApiData<GetApiV1AdminPromotionsByIdResponse>;
export type PromotionList = PromotionAggregate[];
export type CreatePromotionDraftInput = ApiBody<PostApiV1AdminPromotionsData>;
export type CreatePromotionInput = CreatePromotionDraftInput;
export type CreatePromotionPayload = ApiData<PostApiV1AdminPromotionsResponse>;
export type UpdatePromotionDraftInput = ApiBody<PutApiV1AdminPromotionsByIdData>;
export type UpdatePromotionInput = {
  id: string;
} & UpdatePromotionDraftInput;
export type UpdatePromotionPayload = ApiData<PutApiV1AdminPromotionsByIdResponse>;
export type PreviewPromotionInput = {
  id: string;
} & ApiBody<PostApiV1AdminPromotionsByIdPreviewData>;
export type PromotionPreview = ApiData<PostApiV1AdminPromotionsByIdPreviewResponse>;
export type ActivatePromotionPayload =
  ApiData<PostApiV1AdminPromotionsByIdActivateResponse>;
export type PausePromotionPayload =
  ApiData<PostApiV1AdminPromotionsByIdPauseResponse>;
export type PromotionMutationPayload =
  | UpdatePromotionPayload
  | ActivatePromotionPayload
  | PausePromotionPayload;

export interface PromotionRevisionClaim {
  id: string;
  expectedRevision: number;
}

export function buildPromotionsParams(
  input: PromotionsQueryInput,
): Record<string, string> {
  const params: Record<string, string> = {};
  if (input.limit != null) params.limit = String(input.limit);
  if (input.includeDeleted) params.includeDeleted = "true";
  return params;
}

export function promotionResourcePath(id: string): string {
  return `/promotions/${encodeURIComponent(id)}`;
}

export const getPromotions = createServerFn({ method: "GET" })
  .validator((data: PromotionsQueryInput) => data)
  .handler(async ({ data }): Promise<PromotionList> => {
    const payload = await apiGet<PromotionsListPayload>(
      "/promotions",
      buildPromotionsParams(data),
    );
    return payload.promotions;
  });

export const getPromotion = createServerFn({ method: "GET" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<PromotionAggregate> => {
    return apiGet<PromotionAggregate>(promotionResourcePath(data.id));
  });

export const createPromotion = createServerFn({ method: "POST" })
  .validator((data: CreatePromotionInput) => data)
  .handler(async ({ data }): Promise<CreatePromotionPayload> => {
    return apiPost<CreatePromotionPayload>("/promotions", data);
  });

export const updatePromotion = createServerFn({ method: "POST" })
  .validator((data: UpdatePromotionInput) => data)
  .handler(async ({ data }): Promise<UpdatePromotionPayload> => {
    const { id, ...body } = data;
    return apiPut<UpdatePromotionPayload>(promotionResourcePath(id), body);
  });

export const previewPromotion = createServerFn({ method: "POST" })
  .validator((data: PreviewPromotionInput) => data)
  .handler(async ({ data }): Promise<PromotionPreview> => {
    const { id, ...body } = data;
    return apiPost<PromotionPreview>(
      `${promotionResourcePath(id)}/preview`,
      body,
    );
  });

export const activatePromotion = createServerFn({ method: "POST" })
  .validator((data: PromotionRevisionClaim) => data)
  .handler(async ({ data }): Promise<ActivatePromotionPayload> => {
    return apiPost<ActivatePromotionPayload>(
      `${promotionResourcePath(data.id)}/activate`,
      { expectedRevision: data.expectedRevision },
    );
  });

export const pausePromotion = createServerFn({ method: "POST" })
  .validator((data: PromotionRevisionClaim) => data)
  .handler(async ({ data }): Promise<PausePromotionPayload> => {
    return apiPost<PausePromotionPayload>(
      `${promotionResourcePath(data.id)}/pause`,
      { expectedRevision: data.expectedRevision },
    );
  });

export const deletePromotion = createServerFn({ method: "POST" })
  .validator((data: PromotionRevisionClaim) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiDelete<void>(promotionResourcePath(data.id), {
      expectedRevision: data.expectedRevision,
    });
  });
