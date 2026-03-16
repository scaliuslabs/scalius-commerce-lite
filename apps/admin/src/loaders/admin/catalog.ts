import { apiGet } from "@/lib/api-fetch";
import { unixToDate } from "@scalius/shared/utils";

export async function getPageEditData(id: string) {
  const page = await apiGet<any>("/pages/" + id).catch(() => null);
  if (!page) return null;

  return {
    ...page,
    createdAt: unixToDate(page.createdAt) || new Date(),
    updatedAt: unixToDate(page.updatedAt) || new Date(),
    deletedAt: unixToDate(page.deletedAt),
    publishedAt: unixToDate(page.publishedAt),
  };
}

export async function getCategoriesIndexData(options: {
  page: number;
  limit: number;
  search: string;
  showTrashed: boolean;
  sort: "name" | "createdAt" | "updatedAt";
  order: "asc" | "desc";
}) {
  const params: Record<string, string> = {
    page: String(options.page),
    limit: String(options.limit),
    sort: options.sort,
    order: options.order,
  };
  if (options.search) params.search = options.search;
  if (options.showTrashed) params.trashed = "true";

  const [categoriesResult, stats] = await Promise.all([
    apiGet<{ categories: any[]; pagination: any }>("/categories", params),
    apiGet<any>("/products/stats"),
  ]);

  const formattedCategories = categoriesResult.categories.map((category: any) => ({
    ...category,
    createdAt: category.createdAt ? new Date(category.createdAt) : null,
    updatedAt: category.updatedAt ? new Date(category.updatedAt) : null,
    deletedAt: category.deletedAt ? new Date(category.deletedAt) : null,
  }));

  return {
    categories: formattedCategories,
    pagination: categoriesResult.pagination,
    stats,
  };
}

export async function getCategoryEditData(id: string) {
  // Categories API has no GET /{id} endpoint — fetch from list and filter.
  // Acceptable for admin since category counts are low.
  const listResult = await apiGet<{ categories: any[]; pagination: any }>("/categories", {
    page: "1",
    limit: "999",
  });

  const category = listResult.categories.find((c: any) => c.id === id);
  if (!category) return null;

  return {
    ...category,
    slugEdited: true,
    image: category.imageUrl
      ? {
          id: `temp_${category.id}`,
          url: category.imageUrl,
          filename: category.imageUrl.split("/").pop() || "",
          size: 0,
          createdAt: new Date(),
        }
      : null,
  };
}

export async function getCollectionFormOptions() {
  const result = await apiGet<{ categories: any[]; products: any[] }>(
    "/collections/form-options",
  );
  return { allCategories: result.categories, allProducts: result.products };
}

export async function getCollectionEditData(id: string) {
  const [collection, formOptions] = await Promise.all([
    apiGet<any>("/collections/" + id).catch(() => null),
    getCollectionFormOptions(),
  ]);

  if (!collection) return null;

  const parsedConfig =
    typeof collection.config === "string"
      ? JSON.parse(collection.config)
      : collection.config || {};

  const config = {
    categoryIds: parsedConfig.categoryIds || [],
    productIds: parsedConfig.productIds || parsedConfig.specificProductIds || [],
    featuredProductId: parsedConfig.featuredProductId,
    maxProducts: parsedConfig.maxProducts || 8,
    title: parsedConfig.title || "",
    subtitle: parsedConfig.subtitle || "",
  };

  const validCollectionTypesForForm = ["manual", "dynamic"];
  const formType = validCollectionTypesForForm.includes(collection.type)
    ? collection.type
    : "manual";

  return {
    allCategories: formOptions.allCategories,
    allProducts: formOptions.allProducts,
    defaultValues: {
      id: collection.id,
      name: collection.name,
      type: formType as "manual" | "dynamic",
      isActive: collection.isActive,
      config,
    },
  };
}
