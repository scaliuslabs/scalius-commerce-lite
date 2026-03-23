import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { OrderList } from "~/components/admin/order-list";
import { getOrders } from "~/lib/api.functions";

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
  loader: async ({ deps }) => {
    const result = await getOrders({
      data: {
        page: deps.page,
        limit: deps.limit,
        search: deps.search || undefined,
        status: deps.status,
        sort: deps.sort,
        order: deps.order,
        showTrashed: deps.trashed,
      },
    });
    const r = result as any;
    return {
      orders: r.orders || [],
      pagination: r.pagination || { total: 0, page: deps.page, limit: deps.limit, totalPages: 0 },
    };
  },
  head: ({ match }) => ({
    meta: [{ title: `${(match.search as any).trashed ? "Trash" : "Orders"} | Scalius Admin` }],
  }),
  component: OrdersPage,
});

function OrdersPage() {
  const { orders, pagination } = Route.useLoaderData();
  const search = Route.useSearch();

  return (
    <OrderList
      orders={orders}
      pagination={pagination}
      initialSearchQuery={search.search}
      initialSort={{ field: search.sort, order: search.order }}
      showTrashed={search.trashed}
    />
  );
}
