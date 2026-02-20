import type { APIRoute } from "astro";
import { db } from "../../../../db";
import {
  discounts,
  discountProducts,
  discountCollections,
} from "../../../../db/schema";
import { eq } from "drizzle-orm";

export const DELETE: APIRoute = async ({ params }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(
        JSON.stringify({ error: "Discount ID is required" }),
        { status: 400 },
      );
    }

    // Check if discount exists
    const discount = await db
      .select({ id: discounts.id, code: discounts.code })
      .from(discounts)
      .where(eq(discounts.id, id))
      .get();
    if (!discount) {
      return new Response(JSON.stringify({ error: "Discount not found" }), {
        status: 404,
      });
    }

    // Permanently delete the discount and its associations
    await db.batch([
      db.delete(discountProducts).where(eq(discountProducts.discountId, id)),
      db.delete(discountCollections).where(eq(discountCollections.discountId, id)),
      // Add deletion for discountUsage table if needed
      // db.delete(discountUsage).where(eq(discountUsage.discountId, id)),
      db.delete(discounts).where(eq(discounts.id, id)),
    ]);


    return new Response(
      JSON.stringify({
        success: true,
        message: `Discount '${discount.code}' permanently deleted`,
        deletedDiscount: { id: discount.id, code: discount.code },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Error permanently deleting discount:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
    });
  }
};
