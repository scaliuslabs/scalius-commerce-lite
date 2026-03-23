import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { z } from "zod";
import { CustomerList } from "~/components/admin/customer-list";
import { customersQueryOptions } from "~/lib/api.queries";
import type { CustomerListData } from "~/types/api-responses";

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
  loader: async ({ context: { queryClient }, deps }) => {
    await queryClient.ensureQueryData(customersQueryOptions({
      page: deps.page,
      limit: deps.limit,
      search: deps.search || undefined,
      sort: deps.sort,
      order: deps.order,
      showTrashed: deps.trashed,
    }));
  },
  head: ({ match }) => ({
    meta: [{ title: `${match.search.trashed ? "Trash" : "Customers"} | Scalius Admin` }],
  }),
  component: CustomersPage,
});

function CustomersPage() {
  const search = Route.useSearch();
  const { data } = useSuspenseQuery(customersQueryOptions({
    page: search.page,
    limit: search.limit,
    search: search.search || undefined,
    sort: search.sort,
    order: search.order,
    showTrashed: search.trashed,
  }));
  const r = data as Record<string, unknown>;
  const customers = (r.customers || []) as Parameters<typeof CustomerList>[0]["customers"];
  const pagination = (r.pagination || { total: 0, page: search.page, limit: search.limit, totalPages: 0 }) as Parameters<typeof CustomerList>[0]["pagination"];

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
