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

export type CreateOrderReturnInput = { orderId: string } &
  ApiBody<PostApiV1AdminOrdersByIdReturnsData>;
export type ApproveOrderReturnInput = { orderId: string; returnId: string } &
  ApiBody<PostApiV1AdminOrdersByIdReturnsByReturnIdApproveData>;
export type ReceiveOrderReturnInput = { orderId: string; returnId: string } &
  ApiBody<PostApiV1AdminOrdersByIdReturnsByReturnIdReceiveData>;
export type CancelOrderReturnInput = { orderId: string; returnId: string } &
  ApiBody<PostApiV1AdminOrdersByIdReturnsByReturnIdCancelData>;

export interface ReconcileOrderReturnInput {
  orderId: string;
  returnId: string;
}

export function isReturnItemEligible(item: OrderItem): boolean {
  const status = item.fulfillmentStatus?.toLowerCase();
  return status === "shipped" || status === "delivered";
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

  return new Map(
    items.map((item) => [
      item.id,
      isReturnItemEligible(item)
        ? Math.max(0, item.quantity - (committedByItem.get(item.id) ?? 0))
        : 0,
    ]),
  );
}

export function getOutstandingReceiptQuantity(line: OrderReturnLineDto): number {
  return Math.max(0, line.approvedQuantity - line.receivedQuantity);
}

export function returnStatusLabel(status: OrderReturnStatus): string {
  if (status === "receiving") return "Partially received";
  return status[0]!.toUpperCase() + status.slice(1);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function returnCommandIntent(action: string, payload: unknown): string {
  return `${action}:${JSON.stringify(canonicalize(payload))}`;
}

export class StableReturnCommandKey {
  private current: { intent: string; key: string } | null = null;

  constructor(private readonly createKey: (action: string) => string) {}

  get(action: string, payload: unknown): string {
    const intent = returnCommandIntent(action, payload);
    if (this.current?.intent === intent) return this.current.key;
    const key = this.createKey(action);
    this.current = { intent, key };
    return key;
  }

  clear(): void {
    this.current = null;
  }
}
