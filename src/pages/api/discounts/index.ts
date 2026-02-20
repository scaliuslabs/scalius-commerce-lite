import type { APIRoute } from "astro";
import { db } from "../../../db";
import {
  discounts,
  discountProducts,
  discountCollections,
  discountUsage,
  DiscountType,
  DiscountValueType,
} from "../../../db/schema";
import { nanoid } from "nanoid";
import {
  sql,
  desc,
  asc,
  isNull,
  like,
  and,
  isNotNull,
  eq,
  count,
  sum,
} from "drizzle-orm";
import { z } from "zod";

const discountTypeEnum = z.nativeEnum(DiscountType);
const discountValueTypeEnum = z.nativeEnum(DiscountValueType);

const createDiscountSchema = z.object({
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
  customerSegment: z.string().nullable().optional(), // Store specific customer/group IDs if needed
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
  appliesToProducts: z.array(z.string()).optional(), // Array of product IDs
  appliesToCollections: z.array(z.string()).optional(), // Array of collection IDs
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

    const offset = (page - 1) * limit;

    let conditions = [];
    if (search) {
      conditions.push(like(discounts.code, `%${search}%`));
    }
    if (showTrashed) {
      conditions.push(isNotNull(discounts.deletedAt));
    } else {
      conditions.push(isNull(discounts.deletedAt));
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const totalResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(discounts)
      .where(whereClause)
      .get();
    const total = totalResult?.count || 0;

    const sortField =
      sort === "code"
        ? discounts.code
        : sort === "type"
          ? discounts.type
          : sort === "value"
            ? discounts.discountValue
            : sort === "startDate"
              ? discounts.startDate
              : sort === "endDate"
                ? discounts.endDate
                : sort === "createdAt"
                  ? discounts.createdAt
                  : discounts.updatedAt;

    const sortOrder = order === "asc" ? asc(sortField) : desc(sortField);

    const results = await db
      .select()
      .from(discounts)
      .where(whereClause)
      .orderBy(sortOrder)
      .limit(limit)
      .offset(offset);

    // Fetch related products/collections for each discount (could be optimized)
    const discountIds = results.map((d) => d.id);
    let relatedProducts: Record<string, { buy: string[]; get: string[] }> = {};
    let relatedCollections: Record<string, { buy: string[]; get: string[] }> =
      {};

    // Fetch usage statistics for all discounts
    let usageStats: Record<string, { count: number; total: number }> = {};

    if (discountIds.length > 0) {
      const productsResult = await db
        .select()
        .from(discountProducts)
        .where(sql`${discountProducts.discountId} IN ${discountIds}`);
      const collectionsResult = await db
        .select()
        .from(discountCollections)
        .where(sql`${discountCollections.discountId} IN ${discountIds}`);

      // Query for usage statistics
      const usageResults = await db
        .select({
          discountId: discountUsage.discountId,
          count: count(discountUsage.id),
          total: sum(discountUsage.amountDiscounted),
        })
        .from(discountUsage)
        .where(sql`${discountUsage.discountId} IN ${discountIds}`)
        .groupBy(discountUsage.discountId);

      // Convert to lookup object
      usageResults.forEach((result) => {
        usageStats[result.discountId] = {
          count: result.count ? parseInt(String(result.count), 10) : 0,
          total: result.total ? parseFloat(String(result.total)) : 0,
        };
      });

      productsResult.forEach((dp) => {
        if (!relatedProducts[dp.discountId])
          relatedProducts[dp.discountId] = { buy: [], get: [] };
        relatedProducts[dp.discountId][dp.applicationType].push(dp.productId);
      });
      collectionsResult.forEach((dc) => {
        if (!relatedCollections[dc.discountId])
          relatedCollections[dc.discountId] = { buy: [], get: [] };
        relatedCollections[dc.discountId][dc.applicationType].push(
          dc.collectionId,
        );
      });
    }

    const formattedResults = results.map((discount) => {
      // Get usage stats for this discount, defaulting to 0 if not found
      const stats = usageStats[discount.id] || { count: 0, total: 0 };

      return {
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
        // Attach related products/collections
        relatedProducts: relatedProducts[discount.id] || { buy: [], get: [] },
        relatedCollections: relatedCollections[discount.id] || {
          buy: [],
          get: [],
        },
        // Add usage statistics
        usageCount: stats.count,
        totalDiscountAmount: stats.total,
      };
    });

    const totalPages = Math.ceil(total / limit);

    return new Response(
      JSON.stringify({
        discounts: formattedResults,
        pagination: { total, page, limit, totalPages },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("Error fetching discounts:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
    });
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const json = await request.json();
    const data = createDiscountSchema.parse(json);

    // Check if code is unique among non-deleted discounts
    const existingCode = await db
      .select({ id: discounts.id })
      .from(discounts)
      .where(and(eq(discounts.code, data.code), isNull(discounts.deletedAt)))
      .get();

    if (existingCode) {
      return new Response(
        JSON.stringify({ error: "A discount with this code already exists" }),
        { status: 400 },
      );
    }

    const discountId = "disc_" + nanoid();

    // Build related products/collections arrays before the batch
    const productsToInsert: (typeof discountProducts.$inferInsert)[] = [];
    const collectionsToInsert: (typeof discountCollections.$inferInsert)[] = [];

    if (data.type === DiscountType.AMOUNT_OFF_PRODUCTS) {
      (data.appliesToProducts || []).forEach((productId) =>
        productsToInsert.push({
          id: "dp_" + nanoid(),
          discountId,
          productId,
          applicationType: "get",
        }),
      );
      (data.appliesToCollections || []).forEach((collectionId) =>
        collectionsToInsert.push({
          id: "dc_" + nanoid(),
          discountId,
          collectionId,
          applicationType: "get",
        }),
      );
    }

    const batchOps: any[] = [
      db.insert(discounts).values({
        id: discountId,
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
        startDate: sql`unixepoch(${data.startDate.toISOString()})`,
        endDate: data.endDate
          ? sql`unixepoch(${data.endDate.toISOString()})`
          : null,
        isActive: data.isActive,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      }),
    ];

    if (productsToInsert.length > 0) {
      batchOps.push(db.insert(discountProducts).values(productsToInsert));
    }
    if (collectionsToInsert.length > 0) {
      batchOps.push(db.insert(discountCollections).values(collectionsToInsert));
    }

    await db.batch(batchOps as any);

    // Consider if discounts need to be indexed for search

    return new Response(JSON.stringify({ id: discountId }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error creating discount:", error);
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
