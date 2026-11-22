import type {
  GetApiV1AdminOrdersByIdReturnsResponse,
  PostApiV1AdminOrdersByIdReturnsByReturnIdApproveData,
  PostApiV1AdminOrdersByIdReturnsByReturnIdApproveResponse,
  PostApiV1AdminOrdersByIdReturnsByReturnIdCancelData,
  PostApiV1AdminOrdersByIdReturnsByReturnIdReceiveData,
  PostApiV1AdminOrdersByIdReturnsData,
} from "@scalius/api-client/types";
import type { OrderItem } from "@/components/admin/orderview/types";

type ApiData<T> = T extends { success: true; data: infer Data } ? Data : never;
type ApiBody<T extends { body?: unknown }> = NonNullable<T["body"]>;

export type OrderReturnsPayload = ApiData<GetApiV1AdminOrdersByIdReturnsResponse>;
export type OrderReturnDto = OrderReturnsPayload["returns"][number];
export type OrderReturnStatus = OrderReturnDto["status"];
export type OrderReturnLineDto = OrderReturnDto["lines"][number];
export type OrderReturnCommandResult = ApiData<PostApiV1AdminOrdersByIdReturnsByReturnIdApproveResponse>;

// The command hook adds each request's `commandKey`.
type Command<T> = Omit<T, "commandKey">;
export type CreateOrderReturnInput = { orderId: string } &
  Command<ApiBody<PostApiV1AdminOrdersByIdReturnsData>>;
export type ApproveOrderReturnInput = { orderId: string; returnId: string } &
  Command<ApiBody<PostApiV1AdminOrdersByIdReturnsByReturnIdApproveData>>;
export type ReceiveOrderReturnInput = { orderId: string; returnId: string } &
  Command<ApiBody<PostApiV1AdminOrdersByIdReturnsByReturnIdReceiveData>>;
export type CancelOrderReturnInput = { orderId: string; returnId: string } &
  Command<ApiBody<PostApiV1AdminOrdersByIdReturnsByReturnIdCancelData>>;

export interface ReconcileOrderReturnInput {
  orderId: string;
  returnId: string;
}

function committedQuantity(orderReturn: OrderReturnDto, line: OrderReturnLineDto): number {
  if (orderReturn.status === "requested") return line.requestedQuantity;
  if (
    orderReturn.status === "approved" ||
    orderReturn.status === "receiving" ||
    orderReturn.status === "completed"
  ) {
    return line.approvedQuantity;
  }
  return 0;
}

export function getRemainingReturnableQuantities(
  items: readonly OrderItem[],
  returns: readonly OrderReturnDto[],
): Map<string, number> {
  const committedByItem = new Map<string, number>();
  for (const orderReturn of returns) {
    for (const line of orderReturn.lines) {
      committedByItem.set(
        line.orderItemId,
        (committedByItem.get(line.orderItemId) ?? 0) + committedQuantity(orderReturn, line),
      );
    }
  }

  // Only what reached the customer can come back; part of a line may still be unsent.
  return new Map(
    items.map((item) => {
      // Services never reach the buyer as goods, so nothing of them comes back (F12).
      if (item.fulfillmentType !== "ship" && item.fulfillmentType !== "pickup") return [item.id, 0];
      return [item.id, Math.max(0, item.fulfilledQuantity - (committedByItem.get(item.id) ?? 0))];
    }),
  );
}

export function getOutstandingReceiptQuantity(line: OrderReturnLineDto): number {
  return Math.max(0, line.approvedQuantity - line.receivedQuantity);
}

