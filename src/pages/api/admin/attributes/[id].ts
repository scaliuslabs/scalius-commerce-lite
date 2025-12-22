// src/pages/api/admin/attributes/[id].ts
import type { APIRoute } from "astro";
import { db } from "@/db";
import {
  productAttributes,
  productAttributeValues,
  products,
} from "@/db/schema";
import { eq, sql, and, or } from "drizzle-orm";
import { z } from "zod";

const updateAttributeSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters long").optional(),
  slug: z
    .string()
    .min(2, "Slug must be at least 2 characters long")
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid slug format")
    .optional(),
  filterable: z.boolean().optional(),
  options: z.array(z.string()).optional().nullable(), // Predefined values
});

// PUT: Update an attribute
export const PUT: APIRoute = async ({ params, request }) => {
  const { id } = params;
  if (!id) {
    return new Response(JSON.stringify({ error: "ID is required" }), {
      status: 400,
    });
  }

  try {
    const body = await request.json();
    const validation = updateAttributeSchema.safeParse(body);

    if (!validation.success) {
      return new Response(
        JSON.stringify({
          error: "Invalid input",
          details: validation.error.flatten(),
        }),
        { status: 400 },
      );
    }

    const data = validation.data;

    // Check for uniqueness if name or slug are being changed
    if (data.name || data.slug) {
      const orConditions = [];
      if (data.name) orConditions.push(eq(productAttributes.name, data.name));
      if (data.slug) orConditions.push(eq(productAttributes.slug, data.slug));

      const existingAttribute = await db
        .select()
        .from(productAttributes)
        .where(and(or(...orConditions), sql`${productAttributes.id} != ${id}`))
        .get();

      if (existingAttribute) {
        return new Response(
          JSON.stringify({
            error: `An attribute with that name or slug already exists.`,
          }),
          { status: 409 },
        );
      }
    }

    const [updatedAttribute] = await db
      .update(productAttributes)
      .set({
        ...data,
        updatedAt: sql`(cast(strftime('%s','now') as int))`,
      })
      .where(eq(productAttributes.id, id))
      .returning();

    if (!updatedAttribute) {
      return new Response(JSON.stringify({ error: "Attribute not found" }), {
        status: 404,
      });
    }

    return new Response(JSON.stringify({ data: updatedAttribute }), {
      status: 200,
    });
  } catch (error) {
    console.error(`Error updating attribute ${id}:`, error);
    return new Response(
      JSON.stringify({ error: "Failed to update attribute" }),
      { status: 500 },
    );
  }
};

// DELETE: Soft delete an attribute
export const DELETE: APIRoute = async ({ params }) => {
  const { id } = params;
  if (!id) {
    return new Response(JSON.stringify({ error: "ID is required" }), {
      status: 400,
    });
  }

  try {
    // <<< NEW: Check if the attribute is in use by any products >>>
    const usage = await db
      .select({
        productName: products.name,
        productId: products.id,
      })
      .from(productAttributeValues)
      .leftJoin(products, eq(productAttributeValues.productId, products.id))
      .where(eq(productAttributeValues.attributeId, id))
      .limit(5); // Limit to 5 examples to keep the payload small

    if (usage.length > 0) {
      const productNames = usage.map((p) => p.productName).join(", ");
      const errorMessage = `Cannot delete. Attribute is used by ${usage.length}${usage.length < 5 ? "" : "+"} product(s), including: ${productNames}.`;

      return new Response(
        JSON.stringify({
          error: "Attribute in use",
          message: errorMessage,
        }),
        {
          status: 409, // 409 Conflict is the appropriate status code
        },
      );
    }
    // <<< END OF NEW LOGIC >>>

    await db
      .update(productAttributes)
      .set({ deletedAt: sql`(cast(strftime('%s','now') as int))` })
      .where(eq(productAttributes.id, id));

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error(`Error deleting attribute ${id}:`, error);
    return new Response(
      JSON.stringify({ error: "Failed to delete attribute" }),
      { status: 500 },
    );
  }
};
