// src/pages/api/products/[id].ts
import type { APIRoute } from "astro";
import { db } from "../../../db";
import {
  products,
  productImages,
  productAttributeValues,
  productRichContent,
} from "../../../db/schema";
import { eq, sql, and } from "drizzle-orm";
import { z } from "zod";
import { nanoid } from "nanoid";

const updateProductSchema = z.object({
  id: z.string(),
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
      createdAt: z.date().or(z.string()),
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

export const PUT: APIRoute = async ({ request, params }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(JSON.stringify({ error: "Product ID is required" }), {
        status: 400,
      });
    }

    const json = await request.json();
    const data = updateProductSchema.parse(json);

    const existingProduct = await db
      .select({ id: products.id })
      .from(products)
      .where(eq(products.id, id))
      .get();
    if (!existingProduct) {
      return new Response(JSON.stringify({ error: "Product not found" }), {
        status: 404,
      });
    }

    const existingSlug = await db
      .select({ id: products.id })
      .from(products)
      .where(
        and(
          eq(products.slug, data.slug),
          sql`${products.id} != ${id}`,
          sql`${products.deletedAt} IS NULL`,
        ),
      )
      .get();
    if (existingSlug) {
      return new Response(
        JSON.stringify({ error: "A product with this slug already exists" }),
        { status: 400 },
      );
    }

    const attributeValuesToInsert = (data.attributes ?? [])
      .filter((attr) => attr.attributeId && attr.value.trim())
      .map((attr) => ({
        id: `val_${nanoid()}`,
        productId: id,
        attributeId: attr.attributeId,
        value: attr.value,
      }));

    const contentToInsert = (data.additionalInfo ?? [])
      .filter((item) => item.title.trim() && item.content.trim())
      .map((item) => ({
        id: item.id.startsWith("item-") ? `prc_${nanoid()}` : item.id,
        productId: id,
        title: item.title,
        content: item.content,
        sortOrder: item.sortOrder,
      }));

    const batchOps: any[] = [
      db
        .update(products)
        .set({
          name: data.name,
          description: data.description,
          price: data.price,
          categoryId: data.categoryId,
          slug: data.slug,
          metaTitle: data.metaTitle,
          metaDescription: data.metaDescription,
          isActive: data.isActive,
          discountType: data.discountType || "percentage",
          discountPercentage: data.discountPercentage,
          discountAmount: data.discountAmount,
          freeDelivery: data.freeDelivery,
          updatedAt: sql`unixepoch()`,
        })
        .where(eq(products.id, id)),
      db.delete(productImages).where(eq(productImages.productId, id)),
      db.delete(productAttributeValues).where(eq(productAttributeValues.productId, id)),
      db.delete(productRichContent).where(eq(productRichContent.productId, id)),
    ];

    if (data.images.length > 0) {
      batchOps.push(
        db.insert(productImages).values(
          data.images.map((image, index) => ({
            id: image.id.startsWith("temp_") ? `img_${nanoid()}` : image.id,
            productId: id,
            url: image.url,
            alt: image.filename,
            isPrimary: index === 0,
            sortOrder: index,
          })),
        ),
      );
    }

    if (attributeValuesToInsert.length > 0) {
      batchOps.push(db.insert(productAttributeValues).values(attributeValuesToInsert));
    }

    if (contentToInsert.length > 0) {
      batchOps.push(db.insert(productRichContent).values(contentToInsert));
    }

    await db.batch(batchOps as any);

    return new Response(JSON.stringify({ success: true }), { status: 200 });
  } catch (error) {
    console.error("Error updating product:", error);
    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({
          error: "Invalid product data",
          details: error.errors,
        }),
        { status: 400 },
      );
    }
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
    });
  }
};

export const DELETE: APIRoute = async ({ params }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(
        JSON.stringify({
          error: "Product ID is required",
        }),
        { status: 400 },
      );
    }

    await db
      .update(products)
      .set({
        deletedAt: sql`unixepoch()`,
      })
      .where(eq(products.id, id));

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error deleting product:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 },
    );
  }
};