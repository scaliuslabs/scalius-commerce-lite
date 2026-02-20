import type { APIRoute } from "astro";
import { db } from "../../../db";
import { pages } from "../../../db/schema";
import { nanoid } from "nanoid";
import { sql, desc, asc, isNull, like, and, isNotNull } from "drizzle-orm";
import { z } from "zod";

const createPageSchema = z.object({
  title: z.string().min(3).max(100),
  slug: z
    .string()
    .min(3)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  content: z.string(),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  isPublished: z.boolean().default(true),
  publishedAt: z
    .date()
    .or(z.string())
    .nullable()
    .optional()
    .transform((val) =>
      val instanceof Date ? val : val ? new Date(val) : null,
    ),
  sortOrder: z.number().default(0),
  hideHeader: z.boolean().default(false),
  hideFooter: z.boolean().default(false),
  hideTitle: z.boolean().default(false),
});

export const GET: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get("page") || "1");
    const limit = parseInt(url.searchParams.get("limit") || "10");
    const search = url.searchParams.get("search") || "";
    const showTrashed = url.searchParams.get("trashed") === "true";
    const sort = url.searchParams.get("sort") || "updatedAt";
    const order = url.searchParams.get("order") || "desc";

    // Calculate offset
    const offset = (page - 1) * limit;

    // Build query conditions
    let conditions = [];

    // Handle search
    if (search) {
      conditions.push(like(pages.title, `%${search}%`));
    }

    // Handle trashed items
    if (showTrashed) {
      conditions.push(isNotNull(pages.deletedAt));
    } else {
      conditions.push(isNull(pages.deletedAt));
    }

    // Combine conditions
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const totalResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(pages)
      .where(whereClause)
      .get();

    const total = totalResult?.count || 0;

    // Get pages with sorting
    const sortField =
      sort === "title"
        ? pages.title
        : sort === "createdAt"
          ? pages.createdAt
          : sort === "updatedAt"
            ? pages.updatedAt
            : sort === "sortOrder"
              ? pages.sortOrder
              : pages.updatedAt;

    const sortOrder = order === "asc" ? asc(sortField) : desc(sortField);

    const results = await db
      .select()
      .from(pages)
      .where(whereClause)
      .orderBy(sortOrder)
      .limit(limit)
      .offset(offset);

    // Return results with timestamps as-is (Unix timestamps in seconds)
    // Frontend will handle conversion with unixToDate utility
    const formattedResults = results;

    // Calculate pagination info
    const totalPages = Math.ceil(total / limit);

    return new Response(
      JSON.stringify({
        pages: formattedResults,
        pagination: {
          total,
          page,
          limit,
          totalPages,
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
    console.error("Error fetching pages:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 },
    );
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const json = await request.json();
    const data = createPageSchema.parse(json);

    // Check if slug is unique
    const existingPage = await db
      .select({ id: pages.id })
      .from(pages)
      .where(sql`slug = ${data.slug} AND deleted_at IS NULL`)
      .get();

    if (existingPage) {
      return new Response(
        JSON.stringify({
          error: "A page with this slug already exists",
        }),
        { status: 400 },
      );
    }

    const pageId = "page_" + nanoid();

    // Create page
    const [_] = await db
      .insert(pages)
      .values({
        id: pageId,
        title: data.title,
        content: data.content,
        slug: data.slug,
        metaTitle: data.metaTitle || null,
        metaDescription: data.metaDescription || null,
        isPublished: data.isPublished,
        hideHeader: data.hideHeader,
        hideFooter: data.hideFooter,
        hideTitle: data.hideTitle,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
        deletedAt: null,
      })
      .returning();

    // Trigger reindexing in the background
    // We don't await this to avoid delaying the response

    return new Response(JSON.stringify({ id: pageId }), {
      status: 201,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Error creating page:", error);

    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({
          error: "Invalid page data",
          details: error.errors,
        }),
        { status: 400 },
      );
    }

    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 },
    );
  }
};
