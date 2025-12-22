// src/pages/api/admin/navigation/preview-products.ts
import type { APIRoute } from "astro";
import { db } from "@/db";
import {
  products,
  productAttributeValues,
  productAttributes,
} from "@/db/schema";
import { eq, and, isNull, sql } from "drizzle-orm";

// GET: Preview products matching category and attribute filters
export const GET: APIRoute = async ({ url }) => {
  try {
    const searchParams = url.searchParams;
    const categoryId = searchParams.get("categoryId");

    if (!categoryId) {
      return new Response(
        JSON.stringify({ error: "Category ID is required" }),
        { status: 400 },
      );
    }

    // Get all filter parameters (excluding categoryId, page, sortBy)
    const excludeParams = ["categoryId", "page", "sortBy", "limit"];
    const attributeFilters: Record<string, string> = {};

    searchParams.forEach((value, key) => {
      if (!excludeParams.includes(key) && value) {
        attributeFilters[key] = value;
      }
    });

    // Start with products in the category
    let query = db
      .select({
        id: products.id,
        name: products.name,
      })
      .from(products)
      .where(
        and(eq(products.categoryId, categoryId), isNull(products.deletedAt)),
      );

    // Get all products in category first
    const categoryProducts = await query.all();

    if (categoryProducts.length === 0) {
      return new Response(
        JSON.stringify({
          count: 0,
          products: [],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // If no attribute filters, return all category products
    if (Object.keys(attributeFilters).length === 0) {
      return new Response(
        JSON.stringify({
          count: categoryProducts.length,
          products: categoryProducts.slice(0, 10),
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Get attribute IDs by slug
    const attrSlugs = Object.keys(attributeFilters);
    const attrs = await db
      .select({
        id: productAttributes.id,
        slug: productAttributes.slug,
      })
      .from(productAttributes)
      .where(
        sql`${productAttributes.slug} IN (${sql.raw(attrSlugs.map((s) => `'${s}'`).join(","))})`,
      )
      .all();

    const attrIdBySlug = new Map(attrs.map((a) => [a.slug, a.id]));

    // Get products matching ALL attribute filters
    const productIds = categoryProducts.map((p) => p.id);
    const productIdSet = new Set(productIds);

    // For each attribute filter, get matching product IDs
    for (const [slug, value] of Object.entries(attributeFilters)) {
      const attrId = attrIdBySlug.get(slug);
      if (!attrId) continue;

      const matchingProducts = await db
        .select({
          productId: productAttributeValues.productId,
        })
        .from(productAttributeValues)
        .where(
          and(
            eq(productAttributeValues.attributeId, attrId),
            eq(productAttributeValues.value, value),
          ),
        )
        .all();

      const matchingIds = new Set(matchingProducts.map((p) => p.productId));

      // Intersect with current product set
      for (const id of productIdSet) {
        if (!matchingIds.has(id)) {
          productIdSet.delete(id);
        }
      }
    }

    // Get product details for remaining IDs
    const matchingProducts = categoryProducts.filter((p) =>
      productIdSet.has(p.id),
    );

    return new Response(
      JSON.stringify({
        count: matchingProducts.length,
        products: matchingProducts.slice(0, 10),
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Error previewing products:", error);
    return new Response(
      JSON.stringify({ error: "Failed to preview products" }),
      { status: 500 },
    );
  }
};
