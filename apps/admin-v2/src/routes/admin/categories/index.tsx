import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { CategoryList } from "~/components/admin/categories";
import { getCategories, getProductStats } from "~/lib/api.functions";

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
  loader: async ({ deps }) => {
    const [categoriesResult, stats] = await Promise.all([
      getCategories({
        data: {
          page: deps.page,
          limit: deps.limit,
          search: deps.search || undefined,
          sort: deps.sort,
          order: deps.order,
          showTrashed: deps.trashed,
        },
      }) as Promise<any>,
      getProductStats() as Promise<any>,
    ]);
    return {
      categories: (categoriesResult?.categories || []) as any[],
      pagination: (categoriesResult?.pagination || { total: 0, page: deps.page, limit: deps.limit, totalPages: 0 }) as any,
      stats: (stats || {}) as any,
    };
  },
  head: ({ match }) => ({
    meta: [{ title: `${(match.search as any).trashed ? "Trash" : "Categories"} | Scalius Admin` }],
  }),
  component: CategoriesPage,
});

function CategoriesPage() {
  const { categories, pagination, stats } = Route.useLoaderData();
  const search = Route.useSearch();

  return (
    <CategoryList
      categories={categories}
      pagination={{
        total: pagination.total,
        page: search.page,
        limit: search.limit,
        totalPages: pagination.totalPages,
      }}
      initialSearchQuery={search.search}
      initialSort={{ field: search.sort, order: search.order }}
      showTrashed={search.trashed}
      stats={stats ? {
        totalCategories: stats.totalCategories ?? 0,
        categoriesWithImages: stats.categoriesWithImages ?? 0,
        totalProducts: stats.totalProducts,
      } : undefined}
    />
  );
}
