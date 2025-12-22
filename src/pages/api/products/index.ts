// src/pages/api/products/index.ts
import type { APIRoute } from "astro";
import { db } from "../../../db";
import { products, productImages, productRichContent, productAttributeValues } from "../../../db/schema";
import { nanoid } from "nanoid";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { triggerReindex } from "@/lib/search/index";
import { getProducts } from "../../../lib/admin";

const createProductSchema = z.object({
  name: z.string().min(3).max(100),
  description: z.string().min(10).nullable(),
  price: z.number().min(0).max(1000000000000),
  categoryId: z.string().min(1),
  isActive: z.boolean(),
  discountType: z.enum(["percentage", "flat"]).optional(),
  discountPercentage: z.number().min(0).max(100).nullish(),
  discountAmount: z.number().min(0).nullish(),
  freeDelivery: z.boolean(),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  slug: z
    .string()
    .min(3)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  images: z.array(
    z.object({
      id: z.string(),
      url: z.string(),
      filename: z.string(),
      size: z.number(),
      createdAt: z
        .date()
        .or(z.string())
        .transform((val) => (val instanceof Date ? val : new Date(val))),
    }),
  ),
  attributes: z
    .array(
      z.object({
        attributeId: z.string(),
        value: z.string(),
      }),
    )
    .optional(),
  additionalInfo: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      content: z.string(),
      sortOrder: z.number(),
    })
  ).optional(),
});

export const GET: APIRoute = async ({ url }) => {
  try {
    const searchParams = url.searchParams;
    const search = searchParams.get("search") || undefined;
    const categoryId = searchParams.get("category") || undefined;
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "10");
    const sort = (searchParams.get("sort") || "updatedAt") as any;
    const order = (searchParams.get("order") || "desc") as any;

    const { products, pagination } = await getProducts({
      search,
      categoryId,
      page,
      limit,
      sort,
      order,
      showTrashed: false,
    });

    return new Response(JSON.stringify({ products, pagination }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error fetching products:", error);
    return new Response(JSON.stringify({ error: "Failed to fetch products" }), {
      status: 500,
    });
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const json = await request.json();
    const data = createProductSchema.parse(json);

    const existingProduct = await db
      .select({ id: products.id })
      .from(products)
      .where(sql`slug = ${data.slug} AND deleted_at IS NULL`)
      .get();

    if (existingProduct) {
      return new Response(
        JSON.stringify({
          error: "A product with this slug already exists",
        }),
        { status: 400 },
      );
    }

    const productId = "prod_" + nanoid();
    
    await db.transaction(async (tx) => {
      await tx
        .insert(products)
        .values({
          id: productId,
          name: data.name,
          description: data.description || null,
          price: data.price,
          categoryId: data.categoryId,
          slug: data.slug,
          metaTitle: data.metaTitle || null,
          metaDescription: data.metaDescription || null,
          isActive: data.isActive,
          discountType: data.discountType || "percentage",
          discountPercentage: data.discountPercentage || null,
          discountAmount: data.discountAmount || null,
          freeDelivery: data.freeDelivery,
          createdAt: sql`unixepoch()`,
          updatedAt: sql`unixepoch()`,
          deletedAt: null,
        });

      if (data.images.length > 0) {
        await tx.insert(productImages).values(
          data.images.map((image, index) => ({
            id: "img_" + nanoid(),
            productId,
            url: image.url,
            alt: image.filename,
            isPrimary: index === 0,
            sortOrder: index,
          })),
        );
      }
      
      if (data.additionalInfo && data.additionalInfo.length > 0) {
          await tx.insert(productRichContent).values(
              data.additionalInfo.map((item) => ({
                  id: `prc_${nanoid()}`,
                  productId: productId,
                  title: item.title,
                  content: item.content,
                  sortOrder: item.sortOrder,
              }))
          );
      }

      if (data.attributes && data.attributes.length > 0) {
        const attributeValuesToInsert = data.attributes
          .filter((attr) => attr.attributeId && attr.value.trim())
          .map((attr) => ({
            id: `val_${nanoid()}`,
            productId: productId,
            attributeId: attr.attributeId,
            value: attr.value,
          }));
        if (attributeValuesToInsert.length > 0) {
          await tx.insert(productAttributeValues).values(attributeValuesToInsert);
        }
      }
    });


    triggerReindex().catch((error) => {
      console.error(
        "Background reindexing failed after product creation:",
        error,
      );
    });

    return new Response(JSON.stringify({ id: productId }), {
      status: 201,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Error creating product:", error);

    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({
          error: "Invalid product data",
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