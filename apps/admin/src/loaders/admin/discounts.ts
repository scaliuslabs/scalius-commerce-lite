import { apiGet } from "@/lib/api-fetch";
import type {
  Discount,
  PaginationResponse,
  CollectionFormOptions,
} from "@/types/api-responses";

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

  return apiGet<{ discounts: Discount[]; pagination: PaginationResponse }>("/discounts", params);
}

export async function getDiscountEditData(id: string) {
  const discount = await apiGet<Discount>("/discounts/" + id).catch(() => null);
  if (!discount) return null;

  const formOptions = await apiGet<CollectionFormOptions>(
    "/collections/form-options",
  ).catch(() => ({ categories: [], products: [] }));

  const allProductIds = [
    ...(discount.relatedProducts?.buy || []),
    ...(discount.relatedProducts?.get || []),
  ];
  const selectedProducts = formOptions.products.filter((p) =>
    allProductIds.includes(p.id),
  );

  const allCollectionIds = [
    ...(discount.relatedCollections?.buy || []),
    ...(discount.relatedCollections?.get || []),
  ];
  const selectedCollections = allCollectionIds.map((colId: string) => ({
    id: colId,
    name: colId,
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
