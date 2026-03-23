import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ProductList } from "~/components/admin/product-list";
import { getProducts, getCategoryFormOptions, getProductStats } from "~/lib/api.functions";

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
  loader: async ({ deps }) => {
    const [categoryOptions, productsResult, stats] = await Promise.all([
      getCategoryFormOptions().then((r: any) => r.categories || []),
      getProducts({
        data: {
          page: deps.page,
          limit: deps.limit,
          search: deps.search || undefined,
          categoryId: deps.category !== "all" ? deps.category : undefined,
          sort: deps.sort,
          order: deps.order,
          showTrashed: deps.trashed,
        },
      }) as Promise<any>,
      getProductStats() as Promise<any>,
    ]);
    return {
      categories: categoryOptions as any[],
      products: (productsResult?.products || []) as any[],
      pagination: (productsResult?.pagination || { total: 0, page: deps.page, limit: deps.limit, totalPages: 0 }) as any,
      stats: (stats || {}) as any,
    };
  },
  head: ({ match }) => ({
    meta: [{ title: `${(match.search as any).trashed ? "Trash" : "Products"} | Scalius Admin` }],
  }),
  component: ProductsPage,
});

function ProductsPage() {
  const { categories, products, pagination, stats } = Route.useLoaderData();
  const search = Route.useSearch();

  return (
    <ProductList
      products={products}
      categories={categories}
      pagination={pagination}
      initialSearchQuery={search.search}
      initialCategoryId={search.category}
      initialSort={{ field: search.sort, order: search.order }}
      showTrashed={search.trashed}
      stats={stats}
    />
  );
}
