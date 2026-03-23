import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { z } from "zod";
import { OrderList } from "~/components/admin/order-list";
import { ordersQueryOptions } from "~/lib/api.queries";
import type { OrderListItem } from "@scalius/core/modules/orders";

const searchSchema = z.object({
  page: z.number().default(1).catch(1),
  limit: z.number().default(10).catch(10),
  search: z.string().default("").catch(""),
  status: z.string().optional().catch(undefined),
  sort: z.enum(["customerName", "totalAmount", "status", "createdAt", "updatedAt"]).default("updatedAt").catch("updatedAt"),
  order: z.enum(["asc", "desc"]).default("desc").catch("desc"),
  trashed: z.boolean().default(false).catch(false),
});

export const Route = createFileRoute("/admin/orders/")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { queryClient }, deps }) => {
    const params = {
      page: deps.page,
      limit: deps.limit,
      search: deps.search || undefined,
      status: deps.status,
      sort: deps.sort,
      order: deps.order,
      showTrashed: deps.trashed,
    };
    await queryClient.ensureQueryData(ordersQueryOptions(params));
  },
  head: ({ match }) => ({
    meta: [{ title: `${match.search.trashed ? "Trash" : "Orders"} | Scalius Admin` }],
  }),
  component: OrdersPage,
});

function OrdersPage() {
  const search = Route.useSearch();
  const params = {
    page: search.page,
    limit: search.limit,
    search: search.search || undefined,
    status: search.status,
    sort: search.sort,
    order: search.order,
    showTrashed: search.trashed,
  };

  const { data } = useSuspenseQuery(ordersQueryOptions(params));
  const result = data as { orders?: OrderListItem[]; pagination?: { total: number; page: number; limit: number; totalPages: number } };

  return (
    <OrderList
      orders={result.orders ?? []}
      pagination={result.pagination ?? { total: 0, page: search.page, limit: search.limit, totalPages: 0 }}
      initialSearchQuery={search.search}
      initialSort={{ field: search.sort, order: search.order }}
      showTrashed={search.trashed}
    />
  );
}
