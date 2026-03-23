import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { z } from "zod";
import { DiscountList } from "~/components/admin/discount/discount-list";
import { discountsQueryOptions } from "~/lib/api.queries";

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
  loader: async ({ context: { queryClient }, deps }) => {
    await queryClient.ensureQueryData(discountsQueryOptions({
      page: deps.page,
      limit: deps.limit,
      search: deps.search || undefined,
      sort: deps.sort,
      order: deps.order,
      showTrashed: deps.trashed,
    }));
  },
  head: () => ({ meta: [{ title: "Discounts | Scalius Admin" }] }),
  component: DiscountsPage,
});

function DiscountsPage() {
  const search = Route.useSearch();
  const { data } = useSuspenseQuery(discountsQueryOptions({
    page: search.page,
    limit: search.limit,
    search: search.search || undefined,
    sort: search.sort,
    order: search.order,
    showTrashed: search.trashed,
  }));
  const r = data as Record<string, unknown>;

  return (
    <DiscountList
      discounts={(r.discounts || []) as Parameters<typeof DiscountList>[0]["discounts"]}
      pagination={(r.pagination || { total: 0, page: search.page, limit: search.limit, totalPages: 0 }) as Parameters<typeof DiscountList>[0]["pagination"]}
      initialSearchQuery={search.search}
      initialSort={{ field: search.sort, order: search.order }}
      showTrashed={search.trashed}
    />
  );
}
