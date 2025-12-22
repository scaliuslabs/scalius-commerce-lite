// src/pages/api/admin/attributes/[id]/usage.ts
import type { APIRoute } from "astro";
import { db } from "@/db";
import {
  productAttributeValues,
  productAttributes,
  products,
  categories,
} from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";

// GET: Get usage statistics for an attribute, grouped by category
export const GET: APIRoute = async ({ params }) => {
  try {
    const attributeId = params.id;
    if (!attributeId) {
      return new Response(JSON.stringify({ error: "Attribute ID required" }), {
        status: 400,
      });
    }

    // Verify attribute exists
    const attribute = await db
      .select()
      .from(productAttributes)
      .where(
        and(
          eq(productAttributes.id, attributeId),
          isNull(productAttributes.deletedAt),
        ),
      )
      .get();

    if (!attribute) {
      return new Response(JSON.stringify({ error: "Attribute not found" }), {
        status: 404,
      });
    }

    // Get all products using this attribute, with their categories
    const productsWithAttribute = await db
      .select({
        productId: products.id,
        productName: products.name,
        categoryId: products.categoryId,
        categoryName: categories.name,
        value: productAttributeValues.value,
      })
      .from(productAttributeValues)
      .innerJoin(products, eq(productAttributeValues.productId, products.id))
      .leftJoin(categories, eq(products.categoryId, categories.id))
      .where(
        and(
          eq(productAttributeValues.attributeId, attributeId),
          isNull(products.deletedAt),
        ),
      )
      .all();

    // Group by category
    const categoryMap = new Map<
      string,
      {
        id: string;
        name: string;
        productCount: number;
        products: Array<{ id: string; name: string; value: string }>;
      }
    >();

    for (const row of productsWithAttribute) {
      const categoryId = row.categoryId || "uncategorized";
      const categoryName = row.categoryName || "Uncategorized";

      const existing = categoryMap.get(categoryId) || {
        id: categoryId,
        name: categoryName,
        productCount: 0,
        products: [],
      };

      existing.productCount++;
      if (existing.products.length < 10) {
        existing.products.push({
          id: row.productId,
          name: row.productName,
          value: row.value,
        });
      }
      categoryMap.set(categoryId, existing);
    }

    const categoriesData = Array.from(categoryMap.values()).sort(
      (a, b) => b.productCount - a.productCount,
    );

    return new Response(
      JSON.stringify({
        attributeId,
        attributeName: attribute.name,
        totalProducts: productsWithAttribute.length,
        categories: categoriesData,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Error fetching attribute usage:", error);
    return new Response(
      JSON.stringify({ error: "Failed to fetch attribute usage" }),
      { status: 500 },
    );
  }
};
