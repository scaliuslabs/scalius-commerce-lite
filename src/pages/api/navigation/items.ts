import type { APIRoute } from "astro";
import { db } from "../../../db";
import { categories, pages } from "../../../db/schema";
import { isNull, sql } from "drizzle-orm";

export const GET: APIRoute = async () => {
  try {
    // Fetch all active categories
    const categoriesData = await db
      .select({
        id: categories.id,
        name: categories.name,
        slug: categories.slug,
        type: sql<string>`'category'`.as("type"), 
      })
      .from(categories)
      .where(isNull(categories.deletedAt))
      .orderBy(categories.name);

    // Map categories to navigation items
    const categoryItems = categoriesData.map((cat) => ({
      id: cat.id,
      name: cat.name,
      slug: cat.slug,
      type: cat.type,
      url: `/categories/${cat.slug}`,
    }));

    // Fetch all published pages
    const pagesData = await db
      .select({
        id: pages.id,
        title: pages.title,
        slug: pages.slug,
        type: sql<string>`'page'`.as("type"), // Add a type field
        isPublished: pages.isPublished,
      })
      .from(pages)
      .where(sql`${pages.deletedAt} IS NULL AND ${pages.isPublished} = true`)
      .orderBy(pages.title);

    // Map pages to navigation items
    const pageItems = pagesData.map((page) => ({
      id: page.id,
      name: page.title,
      slug: page.slug,
      type: page.type,
      url: `/${page.slug}`,
    }));

    // Return combined navigation items
    return new Response(
      JSON.stringify({
        items: {
          categories: categoryItems,
          pages: pageItems,
        },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    console.error("Error fetching navigation items:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 },
    );
  }
};