import type { ProductFormValues } from "./types";
import type { CreateProductInput } from "@/lib/api-query-options/products";
import { customizationInput } from "./buyer-inputs";
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
  variantPriced: "price",
  fulfillmentKind: "fulfilment",
  isGiftCard: "giftCardProduct",
  warrantyPolicyId: "warranty",
  brandId: "brand",
  customizationSchema: "buyerInputs",
};

/** Product fields an edit sends only when the merchant changed them ("omit to keep"). */
export type ProductSubmitChanges = Partial<Record<"customizationSchema" | "fulfillmentKind" | "isGiftCard" | "warrantyPolicyId" | "brandId", boolean>>;

/** The "omit to keep" fields the merchant changed, from the form's dirty state. */
export function productSubmitChanges(dirty: Partial<Record<keyof ProductFormValues, unknown>>): ProductSubmitChanges {
  return {
    customizationSchema: Boolean(dirty.customizationSchema),
    fulfillmentKind: Boolean(dirty.fulfillmentKind),
    isGiftCard: Boolean(dirty.isGiftCard),
    warrantyPolicyId: Boolean(dirty.warrantyPolicyId),
    brandId: Boolean(dirty.brandId),
  };
}

export function productFieldLabel(field: keyof ProductFormValues): string {
  return translate(productMessages, FIELD_LABELS[field] ?? "product");
}

/**
 * Convert the editor form into the stable product metadata contract. A new
 * product sends `slug` only when the merchant typed it (see useProductSubmit).
 */
export function formatFormValuesForSubmission(
  values: ProductFormValues,
  /** Fields the merchant changed; an edit sends these only then ("omit to keep"). Omit for a new product. */
  changed?: ProductSubmitChanges,
): CreateProductInput & { slug: string } {
  // Buyer inputs fence checkouts in flight: only a real change is sent ("omit to keep").
  const sendInputs = changed ? changed.customizationSchema === true : values.customizationSchema.length > 0;
  // One kind for every SKU; "set per variant" leaves the kinds to the variant table.
  const sendKind = values.fulfillmentKind !== "mixed" && (changed ? changed.fulfillmentKind === true : true);
  // Wave B extras: a new product sends them only when set; an edit only when changed.
  const sendGiftCard = changed ? changed.isGiftCard === true : values.isGiftCard;
  const sendWarranty = changed ? changed.warrantyPolicyId === true : values.warrantyPolicyId !== null;
  // The brand is "omit to keep" too: an edit sends it only when changed.
  const sendBrand = changed ? changed.brandId === true : values.brandId !== null;
  return {
    ...(sendInputs ? { customizationSchema: customizationInput(values.customizationSchema) } : {}),
    ...(sendKind && values.fulfillmentKind !== "mixed" ? { fulfillmentKind: values.fulfillmentKind } : {}),
    ...(sendGiftCard ? { isGiftCard: values.isGiftCard } : {}),
    ...(sendWarranty ? { warrantyPolicyId: values.warrantyPolicyId } : {}),
    ...(sendBrand ? { brandId: values.brandId } : {}),
    name: values.name,
    description: values.description,
    price: values.price ?? 0,
    categoryId: values.categoryId || null,
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
