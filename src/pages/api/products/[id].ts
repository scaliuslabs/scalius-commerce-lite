// src/pages/api/products/[id].ts
import type { APIRoute } from "astro";
import { z } from "zod";
import { updateProductSchema } from "@/modules/products/products.validation";
import { updateProduct, deleteProduct } from "@/modules/products/products.service";
import { safeErrorResponse } from "@/shared/error-utils";

export const PUT: APIRoute = async ({ request, params }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(JSON.stringify({ error: "Product ID is required" }), { status: 400 });
    }

    const data = updateProductSchema.parse(await request.json());
    await updateProduct(id, data);

    return new Response(JSON.stringify({ success: true }), { status: 200 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({ error: "Invalid product data", details: error.errors }),
        { status: 400 },
      );
    }
    if (error instanceof Error && error.message === "Product not found") {
      return new Response(JSON.stringify({ error: error.message }), { status: 404 });
    }
    if (error instanceof Error && error.message.includes("slug")) {
      return new Response(JSON.stringify({ error: error.message }), { status: 400 });
    }
    return safeErrorResponse(error, 500);
  }
};

export const DELETE: APIRoute = async ({ params }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(JSON.stringify({ error: "Product ID is required" }), { status: 400 });
    }

    await deleteProduct(id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return safeErrorResponse(error, 500);
  }
};