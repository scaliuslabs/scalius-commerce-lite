// Webhooks (commerce hook H3): Settings › Webhooks. One list query feeds the
// page; deliveries page by cursor per subscription. A new or rotated signing
// secret is returned to the caller once and never enters a query or mutation
// cache, storage or the URL.
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import {
  deleteApiV1AdminWebhooksById,
  getApiV1AdminWebhooks,
  getApiV1AdminWebhooksById,
  getApiV1AdminWebhooksByIdDeliveries,
  patchApiV1AdminWebhooksById,
  postApiV1AdminWebhooks,
  postApiV1AdminWebhooksByIdDeliveriesByDeliveryIdRetry,
  postApiV1AdminWebhooksByIdRotateSecret,
  postApiV1AdminWebhooksByIdTest,
} from "@scalius/api-client/sdk";
import type {
  PatchApiV1AdminWebhooksByIdData,
  PostApiV1AdminWebhooksData,
  WebhookDelivery,
  WebhookSubscription,
} from "@scalius/api-client/types";
import { apiData } from "../api";
import { queryKeys } from "../query-keys";

export type { WebhookDelivery, WebhookSubscription };

/** The create body; `topics` are event-catalog topic filters. */
export type WebhookInput = NonNullable<PostApiV1AdminWebhooksData["body"]>;
/** The update body, guarded by the version the editor opened. */
export type WebhookUpdate = NonNullable<PatchApiV1AdminWebhooksByIdData["body"]>;

export type WebhookDeliveryStatus = WebhookDelivery["status"];
export const WEBHOOK_DELIVERY_STATUSES = [
  "pending",
  "processing",
  "succeeded",
  "failed",
  "exhausted",
  "cancelled",
] as const satisfies readonly WebhookDeliveryStatus[];

/** A delivery that ended without success can be sent again. */
export const RETRYABLE_DELIVERY_STATUSES: ReadonlySet<string> = new Set<WebhookDeliveryStatus>(["failed", "exhausted", "cancelled"]);

export const WEBHOOK_DELIVERIES_PAGE_SIZE = 25;

export const webhooksQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.webhooks.list(),
    queryFn: () => apiData(getApiV1AdminWebhooks()),
  });

/** Newest deliveries first, one page per "Load more". `status` narrows to one delivery status. */
export const webhookDeliveriesQueryOptions = (id: string, status: WebhookDeliveryStatus | null) =>
  infiniteQueryOptions({
    queryKey: queryKeys.webhooks.deliveries(id, status ?? "all"),
    queryFn: ({ pageParam }) =>
      apiData(getApiV1AdminWebhooksByIdDeliveries({
        path: { id },
        query: { status: status ?? undefined, cursor: pageParam, limit: WEBHOOK_DELIVERIES_PAGE_SIZE },
      })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

export async function getWebhook(id: string) {
  const { subscription } = await apiData(getApiV1AdminWebhooksById({ path: { id } }));
  return subscription;
}

/** The secret is returned once; hand it straight to component state. */
export function createWebhook(body: WebhookInput) {
  return apiData(postApiV1AdminWebhooks({ body }));
}

/** Guarded by the version the editor opened; a stale version answers 409. */
export async function updateWebhook(id: string, body: WebhookUpdate) {
  const { subscription } = await apiData(patchApiV1AdminWebhooksById({ path: { id }, body }));
  return subscription;
}

export function deleteWebhook(id: string) {
  return apiData(deleteApiV1AdminWebhooksById({ path: { id } }));
}

/** The old secret stops working at once; the new one is returned once. */
export function rotateWebhookSecret(id: string) {
  return apiData(postApiV1AdminWebhooksByIdRotateSecret({ path: { id } }));
}

export async function sendWebhookTest(id: string) {
  const { delivery } = await apiData(postApiV1AdminWebhooksByIdTest({ path: { id }, body: {} }));
  return delivery;
}

export async function retryWebhookDelivery(id: string, deliveryId: string) {
  const { delivery } = await apiData(postApiV1AdminWebhooksByIdDeliveriesByDeliveryIdRetry({ path: { id, deliveryId } }));
  return delivery;
}
