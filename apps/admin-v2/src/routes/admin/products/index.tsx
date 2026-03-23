import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { z } from "zod";
import { ProductList } from "~/components/admin/product-list";
import {
  productsQueryOptions,
  categoryFormOptionsQueryOptions,
  productStatsQueryOptions,
} from "~/lib/api.queries";
import type { ProductListItem, Category, ProductStats } from "~/components/admin/product-list/hooks/useProductList";

const searchSchema = z.object({
  page: z.number().default(1).catch(1),
  limit: z.number().default(20).catch(20),
  search: z.string().default("").catch(""),
  category: z.string().default("all").catch("all"),
  sort: z.enum(["name", "price", "category", "createdAt", "updatedAt"]).default("updatedAt").catch("updatedAt"),
  order: z.enum(["asc", "desc"]).default("desc").catch("desc"),
  trashed: z.boolean().default(false).catch(false),
});

export const Route = createFileRoute("/admin/products/")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { queryClient }, deps }) => {
    const productParams = {
      page: deps.page,
      limit: deps.limit,
      search: deps.search || undefined,
      categoryId: deps.category !== "all" ? deps.category : undefined,
      sort: deps.sort,
      order: deps.order,
      showTrashed: deps.trashed,
    };
    await Promise.all([
      queryClient.ensureQueryData(categoryFormOptionsQueryOptions()),
      queryClient.ensureQueryData(productsQueryOptions(productParams)),
      queryClient.ensureQueryData(productStatsQueryOptions()),
    ]);
  },
  head: ({ match }) => ({
    meta: [{ title: `${match.search.trashed ? "Trash" : "Products"} | Scalius Admin` }],
  }),
  component: ProductsPage,
});

function ProductsPage() {
  const search = Route.useSearch();
  const productParams = {
    page: search.page,
    limit: search.limit,
    search: search.search || undefined,
    categoryId: search.category !== "all" ? search.category : undefined,
    sort: search.sort,
    order: search.order,
    showTrashed: search.trashed,
  };

  const { data: categoryData } = useSuspenseQuery(categoryFormOptionsQueryOptions());
  const { data: productsData } = useSuspenseQuery(productsQueryOptions(productParams));
  const { data: stats } = useSuspenseQuery(productStatsQueryOptions());

  const result = productsData as { products?: ProductListItem[]; pagination?: { total: number; page: number; limit: number; totalPages: number } };
  const categories = ((categoryData as Record<string, unknown>)?.categories ?? []) as Category[];
  const statsResult = stats as unknown as ProductStats | null;

  return (
    <ProductList
      products={result.products ?? []}
      categories={categories}
      pagination={{
        total: result.pagination?.total ?? 0,
        page: search.page,
        limit: search.limit,
        totalPages: result.pagination?.totalPages ?? 0,
      }}
      initialSearchQuery={search.search}
      initialCategoryId={search.category}
      initialSort={{ field: search.sort, order: search.order }}
      showTrashed={search.trashed}
      stats={statsResult ?? undefined}
    />
  );
}
