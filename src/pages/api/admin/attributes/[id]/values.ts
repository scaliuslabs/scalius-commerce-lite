// src/pages/api/admin/attributes/[id]/values.ts
import type { APIRoute } from "astro";
import { db } from "@/db";
import {
  productAttributeValues,
  productAttributes,
  products,
} from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { z } from "zod";

// GET: List all unique values for an attribute with product counts
export const GET: APIRoute = async ({ params, request }) => {
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

    // Create Map for unique values
    interface ValueData {
      value: string;
      productCount: number;
      createdAt: Date | number;
      isPreset: boolean;
      sampleProducts: string[];
    }

    // We need to aggregate product names separately since GROUP BY limits us
    // Ideally we'd do a second query or helper map, but for now let's reuse the logic
    // Actually, SQL GROUP BY limits fetching arrays.
    // Let's first get the aggregates correctly.

    // Correction: SQLite doesn't support GROUP_CONCAT distinct easily in simple Drizzle query for names.
    // I'll grab all values first (flat) then aggregate in JS for accuracy on names/counts.
    // This might be heavy for huge datasets but fine for "Lite" alpha.

    const allRows = await db
      .select({
        value: productAttributeValues.value,
        createdAt: productAttributeValues.createdAt, // We want oldest
        productName: products.name,
      })
      .from(productAttributeValues)
      .innerJoin(products, eq(productAttributeValues.productId, products.id))
      .where(
        and(
          eq(productAttributeValues.attributeId, attributeId),
          isNull(products.deletedAt),
        ),
      )
      .all();

    const valueMap = new Map<string, ValueData>();

    // 1. Process used values
    for (const row of allRows) {
      const existing = valueMap.get(row.value) || {
        value: row.value,
        productCount: 0,
        createdAt: row.createdAt,
        isPreset: false, // will update later
        sampleProducts: [],
      };

      existing.productCount++;
      // Keep oldest createdAt
      if (new Date(row.createdAt) < new Date(existing.createdAt)) {
        existing.createdAt = row.createdAt;
      }
      if (existing.sampleProducts.length < 5) {
        existing.sampleProducts.push(row.productName);
      }
      valueMap.set(row.value, existing);
    }

    // 2. Process presets
    const options = (attribute.options as string[]) || [];
    for (const option of options) {
      if (valueMap.has(option)) {
        valueMap.get(option)!.isPreset = true;
      } else {
        valueMap.set(option, {
          value: option,
          productCount: 0,
          createdAt: attribute.updatedAt, // Fallback to attribute update time
          isPreset: true,
          sampleProducts: [],
        });
      }
    }

    // 3. Convert to array, Filter, and Sort
    let allValues = Array.from(valueMap.values());

    const search = new URL(request.url).searchParams.get("search");
    if (search) {
      const lowerSearch = search.toLowerCase();
      allValues = allValues.filter((v) =>
        v.value.toLowerCase().includes(lowerSearch),
      );
    }

    // "Show in order of their creation date time" - usually Newest first? Or Oldest first?
    // User said "Order of creation date time", implies chronological.
    // Attributes usually: Newest first (recently added) is often helpful.
    // Let's support sorting via query param, default to Newest First (Desc).
    const sort = new URL(request.url).searchParams.get("sort") || "desc";

    allValues.sort((a, b) => {
      const timeA = new Date(a.createdAt).getTime();
      const timeB = new Date(b.createdAt).getTime();
      return sort === "asc" ? timeA - timeB : timeB - timeA;
    });

    // 4. Pagination
    const page = parseInt(new URL(request.url).searchParams.get("page") || "1");
    const limit = parseInt(
      new URL(request.url).searchParams.get("limit") || "20",
    ); // Default 20
    const offset = (page - 1) * limit;

    const paginatedValues = allValues.slice(offset, offset + limit);

    return new Response(
      JSON.stringify({
        attributeId,
        attributeName: attribute.name,
        values: paginatedValues,
        totalValues: allValues.length,
        page,
        totalPages: Math.ceil(allValues.length / limit),
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Error fetching attribute values:", error);
    return new Response(
      JSON.stringify({ error: "Failed to fetch attribute values" }),
      { status: 500 },
    );
  }
};

// POST: Add a new preset value
const addValueSchema = z.object({
  value: z.string().min(1, "Value is required"),
});

export const POST: APIRoute = async ({ params, request }) => {
  try {
    const attributeId = params.id;
    if (!attributeId) return new Response(null, { status: 400 });

    const body = await request.json();
    const { value } = addValueSchema.parse(body);

    const attribute = await db
      .select()
      .from(productAttributes)
      .where(eq(productAttributes.id, attributeId))
      .get();

    if (!attribute) return new Response(null, { status: 404 });

    const currentOptions = (attribute.options as string[]) || [];
    if (!currentOptions.includes(value)) {
      const newOptions = [...currentOptions, value];
      await db
        .update(productAttributes)
        .set({ options: newOptions })
        .where(eq(productAttributes.id, attributeId));
    }

    return new Response(JSON.stringify({ success: true }), { status: 200 });
  } catch (error) {
    return new Response(JSON.stringify({ error: "Failed" }), { status: 500 });
  }
};

// PUT: Rename a value across all products
const updateValueSchema = z.object({
  oldValue: z.string().min(1, "Old value is required"),
  newValue: z.string().min(1, "New value is required"),
});

export const PUT: APIRoute = async ({ params, request }) => {
  try {
    const attributeId = params.id;
    if (!attributeId) {
      return new Response(JSON.stringify({ error: "Attribute ID required" }), {
        status: 400,
      });
    }

    const body = await request.json();
    const validation = updateValueSchema.safeParse(body);

    if (!validation.success) {
      return new Response(
        JSON.stringify({
          error: "Invalid input",
          details: validation.error.flatten(),
        }),
        { status: 400 },
      );
    }

    const { oldValue, newValue } = validation.data;

    // 1. Update all occurrences in products
    await db
      .update(productAttributeValues)
      .set({ value: newValue })
      .where(
        and(
          eq(productAttributeValues.attributeId, attributeId),
          eq(productAttributeValues.value, oldValue),
        ),
      );

    // 2. Update options array if exists
    const attribute = await db
      .select()
      .from(productAttributes)
      .where(eq(productAttributes.id, attributeId))
      .get();

    if (attribute) {
      const currentOptions = (attribute.options as string[]) || [];
      if (currentOptions.includes(oldValue)) {
        const newOptions = currentOptions.map((o) =>
          o === oldValue ? newValue : o,
        );
        await db
          .update(productAttributes)
          .set({ options: newOptions })
          .where(eq(productAttributes.id, attributeId));
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Value "${oldValue}" renamed to "${newValue}"`,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Error updating attribute value:", error);
    return new Response(
      JSON.stringify({ error: "Failed to update attribute value" }),
      { status: 500 },
    );
  }
};

// DELETE: Remove a value from all products
const deleteValueSchema = z.object({
  value: z.string().min(1, "Value is required"),
});

export const DELETE: APIRoute = async ({ params, request }) => {
  try {
    const attributeId = params.id;
    if (!attributeId) {
      return new Response(JSON.stringify({ error: "Attribute ID required" }), {
        status: 400,
      });
    }

    const body = await request.json();
    const validation = deleteValueSchema.safeParse(body);

    if (!validation.success) {
      return new Response(
        JSON.stringify({
          error: "Invalid input",
          details: validation.error.flatten(),
        }),
        { status: 400 },
      );
    }

    const { value } = validation.data;

    // 1. Delete all occurrences in products
    await db
      .delete(productAttributeValues)
      .where(
        and(
          eq(productAttributeValues.attributeId, attributeId),
          eq(productAttributeValues.value, value),
        ),
      );

    // 2. Remove from options array if exists
    const attribute = await db
      .select()
      .from(productAttributes)
      .where(eq(productAttributes.id, attributeId))
      .get();

    if (attribute) {
      const currentOptions = (attribute.options as string[]) || [];
      if (currentOptions.includes(value)) {
        const newOptions = currentOptions.filter((o) => o !== value);
        await db
          .update(productAttributes)
          .set({ options: newOptions })
          .where(eq(productAttributes.id, attributeId));
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Value "${value}" deleted from all products`,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Error deleting attribute value:", error);
    return new Response(
      JSON.stringify({ error: "Failed to delete attribute value" }),
      { status: 500 },
    );
  }
};
