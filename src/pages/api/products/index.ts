// src/pages/api/products/index.ts
import type { APIRoute } from "astro";
import { z } from "zod";
import { getProducts } from "@/modules/products";
import { createProductSchema } from "@/modules/products/products.validation";
import { createProduct } from "@/modules/products/products.service";
import { safeErrorResponse } from "@/shared/error-utils";

export const GET: APIRoute = async ({ url }) => {
  try {
    const searchParams = url.searchParams;
    const { products, pagination } = await getProducts({
      search: searchParams.get("search") || undefined,
      categoryId: searchParams.get("category") || undefined,
      page: parseInt(searchParams.get("page") || "1"),
      limit: parseInt(searchParams.get("limit") || "10"),
      sort: (searchParams.get("sort") || "updatedAt") as any,
      order: (searchParams.get("order") || "desc") as any,
      showTrashed: searchParams.get("trashed") === "true",
    });

    return new Response(JSON.stringify({ products, pagination }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return safeErrorResponse(error, 500);
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const data = createProductSchema.parse(await request.json());
    const { id } = await createProduct(data);

    return new Response(JSON.stringify({ id }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({ error: "Invalid product data", details: error.errors }),
        { status: 400 },
      );
    }
    // Business rule violations (slug conflict) – bubble up as 400
    if (error instanceof Error && error.message.includes("slug")) {
      return new Response(JSON.stringify({ error: error.message }), { status: 400 });
    }
    return safeErrorResponse(error, 500);
  }
};