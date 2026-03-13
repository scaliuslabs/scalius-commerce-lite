import { db } from "@scalius/database/client";
import {
  discounts,
  discountProducts,
  discountCollections,
  products,
  collections,
} from "@scalius/database/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { DiscountService } from "@scalius/core/modules/discounts";

export async function getDiscountsIndexData(options: {
  page: number;
  limit: number;
  search: string;
  showTrashed: boolean;
  sort: "code" | "type" | "value" | "startDate" | "endDate" | "createdAt" | "updatedAt";
  order: "asc" | "desc";
}) {
  return DiscountService.list(db, options as any);
}

export async function getDiscountEditData(id: string) {
  const discount = await db
    .select({
      id: discounts.id,
      code: discounts.code,
      type: discounts.type,
      valueType: discounts.valueType,
      discountValue: discounts.discountValue,
      minPurchaseAmount: discounts.minPurchaseAmount,
      minQuantity: discounts.minQuantity,
      maxUsesPerOrder: discounts.maxUsesPerOrder,
      maxUses: discounts.maxUses,
      limitOnePerCustomer: discounts.limitOnePerCustomer,
      combineWithProductDiscounts: discounts.combineWithProductDiscounts,
      combineWithOrderDiscounts: discounts.combineWithOrderDiscounts,
      combineWithShippingDiscounts: discounts.combineWithShippingDiscounts,
      customerSegment: discounts.customerSegment,
      isActive: discounts.isActive,
      deletedAt: discounts.deletedAt,
      startDate: sql<string>`datetime(${discounts.startDate}, 'unixepoch')`,
      endDate: sql<string | null>`datetime(${discounts.endDate}, 'unixepoch')`,
    })
    .from(discounts)
    .where(eq(discounts.id, id))
    .get();

  if (!discount) return null;

  const [productAssociations, collectionAssociations] = await Promise.all([
    db.select().from(discountProducts).where(eq(discountProducts.discountId, id)),
    db.select().from(discountCollections).where(eq(discountCollections.discountId, id)),
  ]);

  const productIds = productAssociations.map((association) => association.productId);
  const collectionIds = collectionAssociations.map(
    (association) => association.collectionId,
  );

  const [selectedProducts, collectionsData] = await Promise.all([
    productIds.length > 0
      ? db
          .select({
            id: products.id,
            name: products.name,
            price: products.price,
            discountPercentage: products.discountPercentage,
          })
          .from(products)
          .where(inArray(products.id, productIds))
      : Promise.resolve([]),
    collectionIds.length > 0
      ? db
          .select({
            id: collections.id,
            name: collections.name,
          })
          .from(collections)
          .where(inArray(collections.id, collectionIds))
      : Promise.resolve([]),
  ]);

  return {
    discount,
    formattedDiscount: {
      ...discount,
      startDate: discount.startDate
        ? new Date(discount.startDate + "Z")
        : new Date(),
      endDate: discount.endDate ? new Date(discount.endDate + "Z") : null,
    },
    selectedProducts,
    selectedCollections: collectionsData.map((collection) => ({
      id: collection.id,
      name: collection.name,
      description: null,
      slug: "",
    })),
  };
}
