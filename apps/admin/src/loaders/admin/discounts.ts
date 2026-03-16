import { apiGet } from "@/lib/api-fetch";

export async function getDiscountsIndexData(options: {
  page: number;
  limit: number;
  search: string;
  showTrashed: boolean;
  sort: "code" | "type" | "value" | "startDate" | "endDate" | "createdAt" | "updatedAt";
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

  return apiGet<any>("/discounts", params);
}

export async function getDiscountEditData(id: string) {
  const discount = await apiGet<any>("/discounts/" + id).catch(() => null);
  if (!discount) return null;

  // The API's getById returns relatedProducts/relatedCollections as { buy: string[], get: string[] }.
  // The admin form needs resolved product/collection details.
  // Fetch product and collection details from the collection form-options endpoint.
  const formOptions = await apiGet<{ categories: any[]; products: any[] }>(
    "/collections/form-options",
  ).catch(() => ({ categories: [], products: [] }));

  // Resolve product IDs to full product objects
  const allProductIds = [
    ...(discount.relatedProducts?.buy || []),
    ...(discount.relatedProducts?.get || []),
  ];
  const selectedProducts = formOptions.products.filter((p: any) =>
    allProductIds.includes(p.id),
  );

  // Resolve collection IDs — we don't have a collections list API with names
  // readily available, but we can use the form-options categories approach.
  // For collections, build minimal objects from what we have.
  const allCollectionIds = [
    ...(discount.relatedCollections?.buy || []),
    ...(discount.relatedCollections?.get || []),
  ];
  const selectedCollections = allCollectionIds.map((colId: string) => ({
    id: colId,
    name: colId, // Will show ID as fallback — page can resolve names client-side
    description: null,
    slug: "",
  }));

  return {
    discount,
    formattedDiscount: {
      ...discount,
      startDate: discount.startDate
        ? new Date(discount.startDate)
        : new Date(),
      endDate: discount.endDate ? new Date(discount.endDate) : null,
    },
    selectedProducts,
    selectedCollections,
  };
}
