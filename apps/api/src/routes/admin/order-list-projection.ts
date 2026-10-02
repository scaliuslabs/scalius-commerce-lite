import { orderSummarySchema } from "../../schemas/entities";

type OrderSummary = ReturnType<typeof orderSummarySchema.parse>;
const orderSummaryKeys = Object.keys(orderSummarySchema.shape);

type OrderListResult = {
  orders: Array<Record<string, unknown>>;
  pagination: {
    total: number;
    totalIsCapped: boolean;
    page: number;
    limit: number;
    totalPages: number;
    offset: number | null;
  };
  pageInfo: {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    startCursor: string | null;
    endCursor: string | null;
  };
};

export function projectOrderListResult(result: OrderListResult) {
  return {
    ...result,
    orders: result.orders.map((order) => {
      const normalized: Record<string, unknown> = {
        ...order,
        createdAt:
          order.createdAt instanceof Date
            ? order.createdAt.toISOString()
            : order.createdAt,
        updatedAt:
          order.updatedAt instanceof Date
            ? order.updatedAt.toISOString()
            : order.updatedAt,
      };
      return Object.fromEntries(
        orderSummaryKeys.map((key) => [key, normalized[key]]),
      ) as OrderSummary;
    }),
  };
}
