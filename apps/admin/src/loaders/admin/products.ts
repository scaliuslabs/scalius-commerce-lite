import { db } from "@scalius/database/client";
import {
  products,
  categories as categoriesTable,
  categories,
  productImages,
  productVariants,
  productAttributeValues,
  productAttributes,
  productRichContent,
} from "@scalius/database/schema";
import { eq, sql } from "drizzle-orm";
import { getProducts, getProductStats } from "@scalius/core/modules/products";

export async function getActiveCategories() {
  return db
    .select({
      id: categoriesTable.id,
      name: categoriesTable.name,
    })
    .from(categoriesTable)
    .where(sql`${categoriesTable.deletedAt} IS NULL`);
}

export async function getProductsIndexData(options: {
  page: number;
  limit: number;
  search: string;
  categoryId?: string;
  sort: "name" | "price" | "category" | "createdAt" | "updatedAt";
  order: "asc" | "desc";
  showTrashed: boolean;
}) {
  const [categoryOptions, { products: productsResult, pagination }, stats] =
    await Promise.all([
      getActiveCategories(),
      getProducts(db, options),
      getProductStats(db),
    ]);

  const formattedProducts = productsResult.map((product) => ({
    ...product,
    createdAt: new Date(product.createdAt),
    updatedAt: new Date(product.updatedAt),
  }));

  return {
    categories: categoryOptions,
    products: formattedProducts,
    pagination,
    stats,
  };
}

export async function getProductEditData(id: string) {
  const product = await db
    .select({
      id: products.id,
      name: products.name,
      description: products.description,
      price: products.price,
      categoryId: products.categoryId,
      slug: products.slug,
      metaTitle: products.metaTitle,
      metaDescription: products.metaDescription,
      isActive: products.isActive,
      discountType: products.discountType,
      discountPercentage: products.discountPercentage,
      discountAmount: products.discountAmount,
      freeDelivery: products.freeDelivery,
    })
    .from(products)
    .where(eq(products.id, id))
    .get();

  if (!product) return null;

  const [images, variants, assignedAttributes, additionalInfo, allCategories] =
    await Promise.all([
      db
        .select({
          id: productImages.id,
          url: productImages.url,
          alt: productImages.alt,
          sortOrder: productImages.sortOrder,
          createdAt: sql<string>`datetime(${productImages.createdAt}, 'unixepoch')`,
        })
        .from(productImages)
        .where(eq(productImages.productId, id))
        .orderBy(productImages.sortOrder),
      db
        .select({
          id: productVariants.id,
          productId: productVariants.productId,
          size: productVariants.size,
          color: productVariants.color,
          weight: productVariants.weight,
          sku: productVariants.sku,
          price: productVariants.price,
          stock: productVariants.stock,
          reservedStock: productVariants.reservedStock,
          barcode: productVariants.barcode,
          barcodeType: productVariants.barcodeType,
          discountType: productVariants.discountType,
          discountPercentage: productVariants.discountPercentage,
          discountAmount: productVariants.discountAmount,
          colorSortOrder: productVariants.colorSortOrder,
          sizeSortOrder: productVariants.sizeSortOrder,
          createdAt: sql<string>`datetime(${productVariants.createdAt}, 'unixepoch')`,
          updatedAt: sql<string>`datetime(${productVariants.updatedAt}, 'unixepoch')`,
          deletedAt: productVariants.deletedAt,
        })
        .from(productVariants)
        .where(
          sql`${productVariants.productId} = ${id} AND ${productVariants.deletedAt} IS NULL`,
        )
        .orderBy(
          productVariants.colorSortOrder,
          productVariants.sizeSortOrder,
          productVariants.createdAt,
        ),
      db
        .select({
          attributeId: productAttributeValues.attributeId,
          value: productAttributeValues.value,
          name: productAttributes.name,
          slug: productAttributes.slug,
        })
        .from(productAttributeValues)
        .leftJoin(
          productAttributes,
          eq(productAttributeValues.attributeId, productAttributes.id),
        )
        .where(eq(productAttributeValues.productId, id)),
      db
        .select({
          id: productRichContent.id,
          title: productRichContent.title,
          content: productRichContent.content,
        })
        .from(productRichContent)
        .where(eq(productRichContent.productId, id))
        .orderBy(productRichContent.sortOrder),
      getActiveCategories(),
    ]);

  const defaultValues = {
    ...product,
    slugEdited: true,
    discountType: (product.discountType || "percentage") as "percentage" | "flat",
    discountPercentage: product.discountPercentage || 0,
    discountAmount: product.discountAmount || 0,
    images: images.map((img) => ({
      id: img.id,
      url: img.url,
      filename: img.alt || img.url.split("/").pop() || "",
      size: 0,
      createdAt: new Date(img.createdAt),
    })),
    attributes: assignedAttributes,
    additionalInfo,
  };

  const formattedVariants = variants.map((variant) => ({
    id: variant.id,
    productId: variant.productId,
    size: variant.size,
    color: variant.color,
    weight: variant.weight,
    sku: variant.sku,
    price: variant.price,
    stock: variant.stock,
    reservedStock: variant.reservedStock,
    barcode: variant.barcode || null,
    barcodeType: variant.barcodeType || null,
    discountType: variant.discountType || "percentage",
    discountPercentage: variant.discountPercentage || 0,
    discountAmount: variant.discountAmount || 0,
    createdAt: new Date(variant.createdAt),
    updatedAt: new Date(variant.updatedAt),
    deletedAt: variant.deletedAt
      ? new Date((variant.deletedAt as unknown as number) * 1000)
      : null,
  }));

  return {
    product,
    allCategories,
    defaultValues,
    formattedVariants,
  };
}

export async function getProductViewData(id: string) {
  const product = await db
    .select({
      id: products.id,
      name: products.name,
      description: products.description,
      price: products.price,
      categoryId: products.categoryId,
      slug: products.slug,
      metaTitle: products.metaTitle,
      metaDescription: products.metaDescription,
      isActive: products.isActive,
      discountPercentage: products.discountPercentage,
      freeDelivery: products.freeDelivery,
      createdAt: sql<number>`CAST(${products.createdAt} AS INTEGER)`,
      updatedAt: sql<number>`CAST(${products.updatedAt} AS INTEGER)`,
      deletedAt: sql<number>`CAST(${products.deletedAt} AS INTEGER)`,
      category: {
        name: categories.name,
      },
    })
    .from(products)
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(eq(products.id, id))
    .get();

  if (!product) return null;

  const [variants, images, additionalInfo] = await Promise.all([
    db
      .select({
        id: productVariants.id,
        size: productVariants.size,
        color: productVariants.color,
        weight: productVariants.weight,
        sku: productVariants.sku,
        price: productVariants.price,
        stock: productVariants.stock,
        reservedStock: productVariants.reservedStock,
        createdAt: sql<number>`CAST(${productVariants.createdAt} AS INTEGER)`,
        updatedAt: sql<number>`CAST(${productVariants.updatedAt} AS INTEGER)`,
        deletedAt: sql<number>`CAST(${productVariants.deletedAt} AS INTEGER)`,
      })
      .from(productVariants)
      .where(eq(productVariants.productId, id)),
    db
      .select({
        id: productImages.id,
        url: productImages.url,
        alt: productImages.alt,
        isPrimary: productImages.isPrimary,
        sortOrder: productImages.sortOrder,
        createdAt: sql<number>`CAST(${productImages.createdAt} AS INTEGER)`,
      })
      .from(productImages)
      .where(eq(productImages.productId, id))
      .orderBy(productImages.sortOrder),
    db
      .select({
        id: productRichContent.id,
        title: productRichContent.title,
        content: productRichContent.content,
      })
      .from(productRichContent)
      .where(eq(productRichContent.productId, id))
      .orderBy(productRichContent.sortOrder),
  ]);

  return {
    ...product,
    createdAt: new Date(product.createdAt * 1000),
    updatedAt: new Date(product.updatedAt * 1000),
    deletedAt: product.deletedAt ? new Date(product.deletedAt * 1000) : null,
    category: {
      name: product.category?.name || "Uncategorized",
    },
    variants: variants.map((variant) => ({
      ...variant,
      createdAt: new Date(variant.createdAt * 1000),
      updatedAt: new Date(variant.updatedAt * 1000),
      deletedAt: variant.deletedAt ? new Date(variant.deletedAt * 1000) : null,
    })),
    images: images.map((image) => ({
      ...image,
      createdAt: new Date(image.createdAt * 1000),
    })),
    additionalInfo,
  };
}
