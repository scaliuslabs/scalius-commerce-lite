import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { CustomerList } from "~/components/admin/customer-list";
import { getCustomers } from "~/lib/api.functions";

const searchSchema = z.object({
  page: z.number().default(1).catch(1),
  limit: z.number().default(10).catch(10),
  search: z.string().default("").catch(""),
  sort: z.enum(["name", "totalOrders", "totalSpent", "lastOrderAt", "createdAt", "updatedAt"]).default("updatedAt").catch("updatedAt"),
  order: z.enum(["asc", "desc"]).default("desc").catch("desc"),
  trashed: z.boolean().default(false).catch(false),
});

export const Route = createFileRoute("/admin/customers/")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const result = await getCustomers({
      data: {
        page: deps.page,
        limit: deps.limit,
        search: deps.search || undefined,
        sort: deps.sort,
        order: deps.order,
        showTrashed: deps.trashed,
      },
    });
    const r = result as any;
    return {
      customers: r.customers || [],
      pagination: r.pagination || { total: 0, page: deps.page, limit: deps.limit, totalPages: 0 },
    };
  },
  head: ({ match }) => ({
    meta: [{ title: `${(match.search as any).trashed ? "Trash" : "Customers"} | Scalius Admin` }],
  }),
  component: CustomersPage,
});

function CustomersPage() {
  const { customers, pagination } = Route.useLoaderData();
  const search = Route.useSearch();

  return (
    <CustomerList
      customers={customers}
      pagination={pagination}
      initialSearchQuery={search.search}
      initialSort={{ field: search.sort, order: search.order }}
      showTrashed={search.trashed}
    />
  );
}
