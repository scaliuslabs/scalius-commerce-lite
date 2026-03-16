import { db } from "@scalius/database/client";
import { categories, products, collections } from "@scalius/database/schema";
import { eq, sql, isNull, and } from "drizzle-orm";
import { unixToDate } from "@scalius/shared/utils";
import { getPageById } from "@scalius/core/modules/pages/pages.service";
import { listCategories } from "@scalius/core/modules/categories/categories.service";
import { getCategoryStats } from "@scalius/core/modules/products";

export async function getPageEditData(id: string) {
  const page = await getPageById(db, id);
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
  const [{ categories: rawCategories, pagination }, stats] = await Promise.all([
    listCategories(db, options),
    getCategoryStats(db),
  ]);

  const formattedCategories = rawCategories.map((category: any) => ({
    ...category,
    createdAt: category.createdAt ? new Date(category.createdAt) : null,
    updatedAt: category.updatedAt ? new Date(category.updatedAt) : null,
    deletedAt: category.deletedAt ? new Date(category.deletedAt) : null,
  }));

  return {
    categories: formattedCategories,
    pagination,
    stats,
  };
}

export async function getCategoryEditData(id: string) {
  const [category] = await db
    .select({
      id: categories.id,
      name: categories.name,
      description: categories.description,
      slug: categories.slug,
      metaTitle: categories.metaTitle,
      metaDescription: categories.metaDescription,
      imageUrl: categories.imageUrl,
      createdAt: sql<string>`datetime(${categories.createdAt}, 'unixepoch', 'localtime')`,
      updatedAt: sql<string>`datetime(${categories.updatedAt}, 'unixepoch', 'localtime')`,
    })
    .from(categories)
    .where(eq(categories.id, id));

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
  const [allCategories, allProducts] = await Promise.all([
    db
      .select({
        id: categories.id,
        name: categories.name,
      })
      .from(categories)
      .where(isNull(categories.deletedAt)),
    db
      .select({
        id: products.id,
        name: products.name,
        categoryId: products.categoryId,
      })
      .from(products)
      .where(isNull(products.deletedAt)),
  ]);

  return { allCategories, allProducts };
}

export async function getCollectionEditData(id: string) {
  const collection = await db
    .select()
    .from(collections)
    .where(and(eq(collections.id, id), isNull(collections.deletedAt)))
    .limit(1)
    .then((rows) => rows[0]);

  if (!collection) return null;

  const { allCategories, allProducts } = await getCollectionFormOptions();
  const parsedConfig = JSON.parse(collection.config);

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
    allCategories,
    allProducts,
    defaultValues: {
      id: collection.id,
      name: collection.name,
      type: formType as "manual" | "dynamic",
      isActive: collection.isActive,
      config,
    },
  };
}
