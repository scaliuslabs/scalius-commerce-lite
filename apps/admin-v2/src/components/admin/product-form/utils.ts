import type { ProductFormValues } from "./types";
import type { CreateProductInput } from "@/lib/api-functions/products";

/** Convert the editor form into the stable product metadata contract. */
export function formatFormValuesForSubmission(
  values: ProductFormValues,
): CreateProductInput {
  return {
    name: values.name,
    description: values.description,
    price: values.price,
    categoryId: values.categoryId,
    isActive: values.isActive,
    discountType: values.discountType,
    discountPercentage:
      values.discountType === "percentage" ? values.discountPercentage : 0,
    discountAmount: values.discountType === "flat" ? values.discountAmount : 0,
    freeDelivery: values.freeDelivery,
    metaTitle: values.metaTitle,
    metaDescription: values.metaDescription?.trim() || null,
    canonicalPath: values.canonicalPath,
    noIndex: values.noIndex,
    excludeFromSitemap: values.excludeFromSitemap,
    excludeFromProductFeed: values.excludeFromProductFeed,
    productCondition: values.productCondition,
    slug: values.slug,
    media: values.media.map((item) => ({
      id: item.id,
      mediaId: item.mediaId,
      altText: item.altText.trim() || null,
      isPrimary: item.isPrimary,
    })),
    attributes: values.attributes?.map(({ attributeId, value }) => ({
      attributeId,
      value,
    })) ?? [],
    additionalInfo: values.additionalInfo?.map((item, sortOrder) => ({
      ...item,
      sortOrder,
    })) ?? [],
  };
}

export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}
