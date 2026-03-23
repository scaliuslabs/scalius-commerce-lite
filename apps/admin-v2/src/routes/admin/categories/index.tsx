import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { z } from "zod";
import { CategoryList } from "~/components/admin/categories";
import { categoriesQueryOptions, productStatsQueryOptions } from "~/lib/api.queries";
import type { Category } from "~/components/admin/categories/hooks/useCategoryList";

const searchSchema = z.object({
  page: z.number().default(1).catch(1),
  limit: z.number().default(20).catch(20),
  search: z.string().default("").catch(""),
  sort: z.enum(["name", "createdAt", "updatedAt"]).default("updatedAt").catch("updatedAt"),
  order: z.enum(["asc", "desc"]).default("desc").catch("desc"),
  trashed: z.boolean().default(false).catch(false),
});

export const Route = createFileRoute("/admin/categories/")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { queryClient }, deps }) => {
    const params = {
      page: deps.page,
      limit: deps.limit,
      search: deps.search || undefined,
      sort: deps.sort,
      order: deps.order,
      showTrashed: deps.trashed,
    };
    await Promise.all([
      queryClient.ensureQueryData(categoriesQueryOptions(params)),
      queryClient.ensureQueryData(productStatsQueryOptions()),
    ]);
  },
  head: ({ match }) => ({
    meta: [{ title: `${match.search.trashed ? "Trash" : "Categories"} | Scalius Admin` }],
  }),
  component: CategoriesPage,
});

function CategoriesPage() {
  const search = Route.useSearch();
  const params = {
    page: search.page,
    limit: search.limit,
    search: search.search || undefined,
    sort: search.sort,
    order: search.order,
    showTrashed: search.trashed,
  };

  const { data: categoriesData } = useSuspenseQuery(categoriesQueryOptions(params));
  const { data: stats } = useSuspenseQuery(productStatsQueryOptions());

  const result = categoriesData as { categories?: Category[]; pagination?: Record<string, unknown> };
  const statsResult = stats as Record<string, unknown> | null;

  return (
    <CategoryList
      categories={result.categories ?? []}
      pagination={{
        total: ((result.pagination as Record<string, number>)?.total) ?? 0,
        page: search.page,
        limit: search.limit,
        totalPages: ((result.pagination as Record<string, number>)?.totalPages) ?? 0,
      }}
      initialSearchQuery={search.search}
      initialSort={{ field: search.sort, order: search.order }}
      showTrashed={search.trashed}
      stats={statsResult ? {
        totalCategories: (statsResult.totalCategories as number) ?? 0,
        categoriesWithImages: (statsResult.categoriesWithImages as number) ?? 0,
        totalProducts: statsResult.totalProducts as number,
      } : undefined}
    />
  );
}
