import { orderSummarySchema } from "../../schemas/entities";

type OrderSummary = ReturnType<typeof orderSummarySchema.parse>;
const orderSummaryKeys = Object.keys(orderSummarySchema.shape);

type OrderListResult = {
  orders: Array<Record<string, unknown>>;
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
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
