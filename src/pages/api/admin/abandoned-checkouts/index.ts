import type { APIRoute } from "astro";
import { db } from "@/db";
import { abandonedCheckouts, type AbandonedCheckout } from "@/db/schema";
import { and, sql, inArray, desc, asc, like, or, count } from "drizzle-orm";
import { z } from "zod";

// Helper to determine if a checkout is "empty" (no customer info, no items)
const isCheckoutEmpty = (checkout: { checkoutData: string; customerPhone: string | null }): boolean => {
  if (checkout.customerPhone) return false;
  try {
    const data = JSON.parse(checkout.checkoutData);
    const items = data.items || [];
    const customerInfo = data.customerInfo || {};
    
    const hasItems = Array.isArray(items) && items.length > 0;
    const hasCustomerInfo = Object.values(customerInfo).some(val => !!val);

    return !hasItems && !hasCustomerInfo;
  } catch {
    return true; // Corrupt JSON is considered empty
  }
};

export const GET: APIRoute = async ({ url }) => {
  try {
    // --- Perform Cleanup ---
    // 1. Delete any checkouts older than 30 days, regardless of content
    const thirtyDaysAgoTimestamp = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
    await db.delete(abandonedCheckouts).where(sql`${abandonedCheckouts.createdAt} <= ${thirtyDaysAgoTimestamp}`);

    // 2. Find and delete empty checkouts older than 1 hour
    const oneHourAgoTimestamp = Math.floor((Date.now() - 60 * 60 * 1000) / 1000);
    const candidatesForDeletion = await db.select().from(abandonedCheckouts).where(sql`${abandonedCheckouts.updatedAt} <= ${oneHourAgoTimestamp}`);
    
    const emptyCheckoutIds = candidatesForDeletion
      .filter(isCheckoutEmpty)
      .map(c => c.id);

    if (emptyCheckoutIds.length > 0) {
      await db.delete(abandonedCheckouts).where(inArray(abandonedCheckouts.id, emptyCheckoutIds));
    }

    // --- Fetch Data for UI ---
    const searchParams = url.searchParams;
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "20");
    const search = searchParams.get("search") || "";
    const sort = (searchParams.get("sort") || "updatedAt") as keyof AbandonedCheckout;
    const order = searchParams.get("order") || "desc";
    const offset = (page - 1) * limit;

    const whereConditions = [];
    if (search) {
      whereConditions.push(
        or(
          like(abandonedCheckouts.customerPhone, `%${search}%`),
          like(abandonedCheckouts.checkoutId, `%${search}%`),
          like(abandonedCheckouts.checkoutData, `%${search}%`)
        )
      );
    }

    const combinedWhere = whereConditions.length > 0 ? and(...whereConditions) : undefined;

    const results = await db.select().from(abandonedCheckouts).where(combinedWhere).orderBy(
        order === 'asc' 
            ? asc(abandonedCheckouts[sort]) 
            : desc(abandonedCheckouts[sort])
    ).limit(limit).offset(offset);

    const totalResult = await db.select({ total: count() }).from(abandonedCheckouts).where(combinedWhere);
    const total = totalResult[0].total;

    return new Response(JSON.stringify({ 
        data: results,
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        }
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (error: any) {
    console.error("Error fetching abandoned checkouts:", error);
    return new Response(JSON.stringify({ error: "Failed to fetch data", message: error.message }), { status: 500 });
  }
};

const bulkDeleteSchema = z.object({
  ids: z.array(z.string()).min(1, "No IDs provided"),
});

export const DELETE: APIRoute = async ({ request }) => {
    try {
        const json = await request.json();
        const validation = bulkDeleteSchema.safeParse(json);
        if (!validation.success) {
            return new Response(JSON.stringify({ error: "Invalid input", details: validation.error.flatten() }), { status: 400 });
        }
        
        await db.delete(abandonedCheckouts).where(inArray(abandonedCheckouts.id, validation.data.ids));

        return new Response(null, { status: 204 });

    } catch (error) {
        console.error("Error bulk deleting checkouts:", error);
        return new Response(JSON.stringify({ error: "Failed to bulk delete checkouts" }), { status: 500 });
    }
};