import type { APIRoute } from "astro";
import { db } from "@/db";
import {
  products,
  productImages,
  productVariants,
  categories,
  productAttributes,
  productAttributeValues,
  type Category,
  type Product,
  type ProductImage,
  type ProductVariant,
  type ProductAttributeValue,
} from "@/db/schema";
import { inArray, eq, isNull } from "drizzle-orm";
import { getStorefrontPath } from "@/lib/storefront-url";

interface VariantWithBuyNowUrl extends ProductVariant {
  buyNowUrl: string;
  finalPrice: number;
}

interface ProductContextDetail extends Product {
  url: string;
  buyNowUrl: string;
  finalPrice: number;
  category: (Pick<Category, "id" | "name" | "slug"> & { url: string }) | null;
  images: ProductImage[];
  variants: VariantWithBuyNowUrl[];
  attributes: (ProductAttributeValue & { name: string; slug: string })[];
}

// Helper function to calculate final price
function calculateFinalPrice(
  basePrice: number,
  discountType: "percentage" | "flat" | null,
  discountAmount: number | null,
  discountPercentage: number | null
): number {
  if (!discountType) return basePrice;

  if (discountType === "percentage" && discountPercentage) {
    return basePrice - (basePrice * discountPercentage) / 100;
  } else if (discountType === "flat" && discountAmount) {
    return Math.max(0, basePrice - discountAmount);
  }

  return basePrice;
}

interface CategoryContextDetail extends Category {
  url: string;
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { productIds, categoryIds, allCategories } = body as {
      productIds?: string[];
      categoryIds?: string[];
      allCategories?: boolean;
    };

    let productsData: ProductContextDetail[] = [];
    let fetchedCategories: Category[] = [];

    if (productIds && productIds.length > 0) {
      const productResults = await db
        .select()
        .from(products)
        .where(inArray(products.id, productIds));

      if (productResults.length > 0) {
        const allProductIds = productResults.map((p) => p.id);
        const allCategoryIds = productResults
          .map((p) => p.categoryId)
          .filter(Boolean) as string[];

        const [images, variants, attributesResult, categoryResults] =
          await Promise.all([
            db
              .select()
              .from(productImages)
              .where(inArray(productImages.productId, allProductIds)),
            db
              .select()
              .from(productVariants)
              .where(inArray(productVariants.productId, allProductIds)),
            db
              .select({
                value: productAttributeValues,
                attribute: productAttributes,
              })
              .from(productAttributeValues)
              .innerJoin(
                productAttributes,
                eq(productAttributeValues.attributeId, productAttributes.id),
              )
              .where(inArray(productAttributeValues.productId, allProductIds)),
            allCategoryIds.length > 0
              ? db
                  .select()
                  .from(categories)
                  .where(inArray(categories.id, allCategoryIds))
              : Promise.resolve([]),
          ]);

        const categoriesWithUrls = await Promise.all(
          categoryResults.map(async (cat) => ({
            ...cat,
            url: await getStorefrontPath(`/categories/${cat.slug}`),
          })),
        );
        const categoryMap = new Map(categoriesWithUrls.map((c) => [c.id, c]));

        for (const product of productResults) {
          const productUrl = await getStorefrontPath(
            `/products/${product.slug}`,
          );
          const buyNowUrl = await getStorefrontPath(`/buy/${product.slug}`);
          const productCategory = product.categoryId
            ? categoryMap.get(product.categoryId)
            : null;

          const productVariants = variants.filter((v) => v.productId === product.id);
          const variantsWithBuyNowUrls: VariantWithBuyNowUrl[] = await Promise.all(
            productVariants.map(async (variant) => {
              const finalPrice = calculateFinalPrice(
                variant.price,
                variant.discountType,
                variant.discountAmount,
                variant.discountPercentage
              );

              return {
                ...variant,
                buyNowUrl: await getStorefrontPath(`/buy/${product.slug}?variant=${variant.id}`),
                finalPrice,
              };
            })
          );

          const productFinalPrice = calculateFinalPrice(
            product.price,
            product.discountType,
            product.discountAmount,
            product.discountPercentage
          );

          productsData.push({
            ...product,
            url: productUrl,
            buyNowUrl: buyNowUrl,
            finalPrice: productFinalPrice,
            category: productCategory
              ? {
                  id: productCategory.id,
                  name: productCategory.name,
                  slug: productCategory.slug,
                  url: productCategory.url,
                }
              : null,
            images: images.filter((img) => img.productId === product.id),
            variants: variantsWithBuyNowUrls,
            attributes: attributesResult
              .filter((attr) => attr.value.productId === product.id)
              .map((res) => ({
                ...res.value,
                name: res.attribute.name,
                slug: res.attribute.slug,
              })),
          });
        }
      }
    }

    if (allCategories) {
      fetchedCategories = await db
        .select()
        .from(categories)
        .where(isNull(categories.deletedAt));
    } else if (categoryIds && categoryIds.length > 0) {
      fetchedCategories = await db
        .select()
        .from(categories)
        .where(inArray(categories.id, categoryIds));
    }

    const categoriesData: CategoryContextDetail[] = await Promise.all(
      fetchedCategories.map(async (cat) => {
        const url = await getStorefrontPath(`/categories/${cat.slug}`);
        return { ...cat, url };
      }),
    );

    return new Response(
      JSON.stringify({
        products: productsData,
        categories: categoriesData,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Error fetching batch details:", error);
    return new Response(
      JSON.stringify({ error: "Failed to fetch context details" }),
      { status: 500 },
    );
  }
};