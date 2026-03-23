import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { DiscountList } from "~/components/admin/discount/discount-list";
import { getDiscounts } from "~/lib/api.functions";

const searchSchema = z.object({
  page: z.number().default(1).catch(1),
  limit: z.number().default(10).catch(10),
  search: z.string().default("").catch(""),
  sort: z.enum(["code", "type", "value", "startDate", "endDate", "createdAt", "updatedAt"]).default("updatedAt").catch("updatedAt"),
  order: z.enum(["asc", "desc"]).default("desc").catch("desc"),
  trashed: z.boolean().default(false).catch(false),
});

export const Route = createFileRoute("/admin/discounts/")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const result = await getDiscounts({
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
      discounts: r.discounts || [],
      pagination: r.pagination || { total: 0, page: deps.page, limit: deps.limit, totalPages: 0 },
    };
  },
  head: () => ({ meta: [{ title: "Discounts | Scalius Admin" }] }),
  component: DiscountsPage,
});

function DiscountsPage() {
  const { discounts, pagination } = Route.useLoaderData();
  const search = Route.useSearch();

  return (
    <DiscountList
      discounts={discounts}
      pagination={pagination}
      initialSearchQuery={search.search}
      initialSort={{ field: search.sort, order: search.order }}
      showTrashed={search.trashed}
    />
  );
}
