import type { APIRoute } from "astro";
import { db } from "../../../../db";
import {
  orderItems,
  products,
  productVariants,
  productImages,
} from "../../../../db/schema";
import { eq, and } from "drizzle-orm";

export const GET: APIRoute = async ({ params }) => {
  const { id: orderId } = params;

  if (!orderId) {
    return new Response(JSON.stringify({ error: "Order ID is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const items = await db
      .select({
        id: orderItems.id,
        productId: orderItems.productId,
        productName: products.name,
        productImage: productImages.url,
        variantId: orderItems.variantId,
        variantSize: productVariants.size,
        variantColor: productVariants.color,
        quantity: orderItems.quantity,
        price: orderItems.price,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .leftJoin(products, eq(orderItems.productId, products.id))
      .leftJoin(productVariants, eq(orderItems.variantId, productVariants.id))
      .leftJoin(
        productImages,
        and(
          eq(productImages.productId, orderItems.productId),
          eq(productImages.isPrimary, true),
        ),
      );
    // Consider adding `and(isNull(products.deletedAt))` if needed

    // Type assertion might be needed depending on PopoverOrderItem structure
    // For now, assuming the select matches

    return new Response(JSON.stringify(items), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error(`Error fetching items for order ${orderId}:`, error);
    return new Response(
      JSON.stringify({ error: "Failed to fetch order items" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};
