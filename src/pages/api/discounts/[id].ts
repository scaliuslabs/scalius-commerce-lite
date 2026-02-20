import type { APIRoute } from "astro";
import { db } from "../../../db";
import {
  discounts,
  discountProducts,
  discountCollections,
  DiscountType,
  DiscountValueType,
} from "../../../db/schema";
import { eq, sql, and, isNull } from "drizzle-orm";
import { z } from "zod";
import { nanoid } from "nanoid";

const discountTypeEnum = z.nativeEnum(DiscountType);
const discountValueTypeEnum = z.nativeEnum(DiscountValueType);

const updateDiscountSchema = z.object({
  id: z.string(),
  code: z.string().min(3).max(50),
  type: discountTypeEnum,
  valueType: discountValueTypeEnum,
  discountValue: z.number().positive(),
  minPurchaseAmount: z.number().nullable().optional(),
  minQuantity: z.number().int().positive().nullable().optional(),
  maxUsesPerOrder: z.number().int().positive().nullable().optional(),
  maxUses: z.number().int().positive().nullable().optional(),
  limitOnePerCustomer: z.boolean().default(false),
  combineWithProductDiscounts: z.boolean().default(false),
  combineWithOrderDiscounts: z.boolean().default(false),
  combineWithShippingDiscounts: z.boolean().default(false),
  customerSegment: z.string().nullable().optional(),
  startDate: z
    .date()
    .or(z.string())
    .or(z.number())
    .transform((val) => {
      if (typeof val === "number") {
        // Check if it's seconds (has fewer digits than milliseconds)
        return new Date(val < 10000000000 ? val * 1000 : val);
      }
      return new Date(val);
    }),
  endDate: z
    .date()
    .or(z.string())
    .or(z.number())
    .nullable()
    .optional()
    .transform((val) => {
      if (!val) return null;
      if (typeof val === "number") {
        // Check if it's seconds (has fewer digits than milliseconds)
        return new Date(val < 10000000000 ? val * 1000 : val);
      }
      return new Date(val);
    }),
  isActive: z.boolean().default(true),
  appliesToProducts: z.array(z.string()).optional(),
  appliesToCollections: z.array(z.string()).optional(),
});

export const GET: APIRoute = async ({ params }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(
        JSON.stringify({ error: "Discount ID is required" }),
        { status: 400 },
      );
    }

    const discount = await db
      .select()
      .from(discounts)
      .where(eq(discounts.id, id))
      .get();

    if (!discount) {
      return new Response(JSON.stringify({ error: "Discount not found" }), {
        status: 404,
      });
    }

    // Fetch related products/collections
    const productsResult = await db
      .select()
      .from(discountProducts)
      .where(eq(discountProducts.discountId, id));
    const collectionsResult = await db
      .select()
      .from(discountCollections)
      .where(eq(discountCollections.discountId, id));

    const relatedProducts: { buy: string[]; get: string[] } = {
      buy: [],
      get: [],
    };
    const relatedCollections: { buy: string[]; get: string[] } = {
      buy: [],
      get: [],
    };

    productsResult.forEach((dp) =>
      relatedProducts[dp.applicationType].push(dp.productId),
    );
    collectionsResult.forEach((dc) =>
      relatedCollections[dc.applicationType].push(dc.collectionId),
    );

    const formattedDiscount = {
      ...discount,
      createdAt: discount.createdAt
        ? new Date(Number(discount.createdAt) * 1000).toISOString()
        : null,
      updatedAt: discount.updatedAt
        ? new Date(Number(discount.updatedAt) * 1000).toISOString()
        : null,
      deletedAt: discount.deletedAt
        ? new Date(Number(discount.deletedAt) * 1000).toISOString()
        : null,
      startDate: discount.startDate
        ? new Date(Number(discount.startDate) * 1000).toISOString()
        : null,
      endDate: discount.endDate
        ? new Date(Number(discount.endDate) * 1000).toISOString()
        : null,
      relatedProducts,
      relatedCollections,
    };

    return new Response(JSON.stringify(formattedDiscount), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error fetching discount:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
    });
  }
};

export const PUT: APIRoute = async ({ request, params }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(
        JSON.stringify({ error: "Discount ID is required" }),
        { status: 400 },
      );
    }

    const json = await request.json();
    const data = updateDiscountSchema.parse({ ...json, id }); // Ensure ID is part of parsed data

    // Check if discount exists
    const existingDiscount = await db
      .select({ id: discounts.id })
      .from(discounts)
      .where(eq(discounts.id, id))
      .get();
    if (!existingDiscount) {
      return new Response(JSON.stringify({ error: "Discount not found" }), {
        status: 404,
      });
    }

    // Check if code is unique (excluding current discount)
    const existingCode = await db
      .select({ id: discounts.id })
      .from(discounts)
      .where(
        and(
          eq(discounts.code, data.code),
          sql`${discounts.id} != ${id}`,
          isNull(discounts.deletedAt),
        ),
      )
      .get();
    if (existingCode) {
      return new Response(
        JSON.stringify({ error: "A discount with this code already exists" }),
        { status: 400 },
      );
    }

    // Compute timestamps outside of batch (startDate fallback requires a SELECT)
    const currentTimestamp = Math.floor(Date.now() / 1000);

    let startDateTimestamp: number;
    try {
      if (data.startDate instanceof Date && !isNaN(data.startDate.getTime())) {
        startDateTimestamp = Math.floor(data.startDate.getTime() / 1000);
      } else {
        const existingDiscountTs = await db
          .select({ startDate: discounts.startDate })
          .from(discounts)
          .where(eq(discounts.id, id))
          .get();
        const storedStartDate = existingDiscountTs?.startDate;
        startDateTimestamp =
          typeof storedStartDate === "number" ? storedStartDate : currentTimestamp;
      }
    } catch (error) {
      console.error("Error processing startDate:", error);
      startDateTimestamp = currentTimestamp;
    }

    let endDateTimestamp: number | null = null;
    if (data.endDate) {
      try {
        if (data.endDate instanceof Date && !isNaN(data.endDate.getTime())) {
          endDateTimestamp = Math.floor(data.endDate.getTime() / 1000);
        }
      } catch (error) {
        console.error("Error processing endDate:", error);
      }
    }

    // Build new associations before batch
    const productsToInsert: (typeof discountProducts.$inferInsert)[] = [];
    const collectionsToInsert: (typeof discountCollections.$inferInsert)[] = [];

    if (data.type === DiscountType.AMOUNT_OFF_PRODUCTS) {
      (data.appliesToProducts || []).forEach((productId) =>
        productsToInsert.push({
          id: "dp_" + nanoid(),
          discountId: id,
          productId,
          applicationType: "get",
        }),
      );
      (data.appliesToCollections || []).forEach((collectionId) =>
        collectionsToInsert.push({
          id: "dc_" + nanoid(),
          discountId: id,
          collectionId,
          applicationType: "get",
        }),
      );
    }

    const batchOps: any[] = [
      db
        .update(discounts)
        .set({
          code: data.code,
          type: data.type,
          valueType: data.valueType,
          discountValue: data.discountValue,
          minPurchaseAmount: data.minPurchaseAmount,
          minQuantity: data.minQuantity,
          maxUsesPerOrder: data.maxUsesPerOrder,
          maxUses: data.maxUses,
          limitOnePerCustomer: data.limitOnePerCustomer,
          combineWithProductDiscounts: data.combineWithProductDiscounts,
          combineWithOrderDiscounts: data.combineWithOrderDiscounts,
          combineWithShippingDiscounts: data.combineWithShippingDiscounts,
          customerSegment: data.customerSegment,
          startDate: sql`${startDateTimestamp}`,
          endDate: endDateTimestamp !== null ? sql`${endDateTimestamp}` : null,
          isActive: data.isActive,
          updatedAt: sql`${currentTimestamp}`,
        })
        .where(eq(discounts.id, id)),
      db.delete(discountProducts).where(eq(discountProducts.discountId, id)),
      db.delete(discountCollections).where(eq(discountCollections.discountId, id)),
    ];

    if (productsToInsert.length > 0) {
      batchOps.push(db.insert(discountProducts).values(productsToInsert));
    }
    if (collectionsToInsert.length > 0) {
      batchOps.push(db.insert(discountCollections).values(collectionsToInsert));
    }

    await db.batch(batchOps as any);

    // Consider reindexing if necessary

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error updating discount:", error);
    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({
          error: "Invalid discount data",
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
        JSON.stringify({ error: "Discount ID is required" }),
        { status: 400 },
      );
    }

    // Soft delete the discount
    await db
      .update(discounts)
      .set({ deletedAt: sql`unixepoch()` })
      .where(eq(discounts.id, id));


    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error deleting discount:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
    });
  }
};
