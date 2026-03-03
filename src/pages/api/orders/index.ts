// src/pages/api/orders/index.ts
import type { APIRoute } from "astro";
import { z } from "zod";
import { getOrders } from "@/modules/orders";
import { createOrder } from "@/modules/orders/orders.service";
import { createOrderSchema } from "@/modules/orders/orders.validation";
import { safeErrorResponse } from "@/shared/error-utils";

export const GET: APIRoute = async ({ url }) => {
  try {
    const searchParams = url.searchParams;
    const startDateParam = searchParams.get("startDate");
    const endDateParam = searchParams.get("endDate");

    const { orders, pagination } = await getOrders({
      page: parseInt(searchParams.get("page") || "1"),
      limit: parseInt(searchParams.get("limit") || "10"),
      search: searchParams.get("search") || "",
      status: searchParams.get("status") || undefined,
      showTrashed: searchParams.get("trashed") === "true",
      sort: (searchParams.get("sort") || "updatedAt") as any,
      order: (searchParams.get("order") || "desc") as "asc" | "desc",
      startDate: startDateParam ? new Date(startDateParam) : undefined,
      endDate: endDateParam ? new Date(endDateParam) : undefined,
    });

    return new Response(JSON.stringify({ orders, pagination }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return safeErrorResponse(error, 500);
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const data = createOrderSchema.parse(await request.json());
    const { id } = await createOrder(data);

    return new Response(JSON.stringify({ id }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({ error: "Validation failed", details: error.errors }),
        { status: 400 },
      );
    }
    return safeErrorResponse(error, 500);
  }
};
