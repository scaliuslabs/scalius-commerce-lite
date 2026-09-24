import type { ProductFormValues } from "./types";
import type { CreateProductInput } from "@/lib/api-query-options/products";
import { translate } from "~/i18n";
import { productMessages, type ProductMessageKey } from "~/i18n/products";

/** What the merchant calls each product field (save banner, conflict dialog). */
const FIELD_LABELS: Record<keyof ProductFormValues, ProductMessageKey> = {
  id: "product",
  name: "title",
  description: "description",
  price: "price",
  categoryId: "category",
  isActive: "status",
  discountType: "discount",
  discountPercentage: "discount",
  discountAmount: "discount",
  freeDelivery: "freeDelivery",
  metaTitle: "searchListing",
  metaDescription: "searchListing",
  canonicalPath: "searchListing",
  noIndex: "searchListing",
  excludeFromSitemap: "searchListing",
  excludeFromProductFeed: "searchListing",
  productCondition: "condition",
  slug: "webAddress",
  media: "media",
  attributes: "attributes",
  additionalInfo: "additionalSections",
  slugEdited: "webAddress",
};

export function productFieldLabel(field: keyof ProductFormValues): string {
  return translate(productMessages, FIELD_LABELS[field] ?? "product");
}

/** Convert the editor form into the stable product metadata contract. */
export function formatFormValuesForSubmission(
  values: ProductFormValues,
): CreateProductInput {
  return {
    name: values.name,
    description: values.description,
    price: values.price ?? 0,
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
