// src/pages/api/products/[slug].ts
import type { APIRoute } from "astro";
import { getProductBySlug } from "@/lib/api";

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  const { slug } = params;
  if (!slug) {
    return new Response(JSON.stringify({ error: "Slug is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    // FIXED: Call getProductBySlug with requiresAuth set to false
    const productData = await getProductBySlug(slug, false);
    
    if (!productData) {
      return new Response(JSON.stringify({ error: "Product not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(productData), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        // Align with Hono API: browser revalidates so users see changes after KV invalidation
        "Cache-Control":
          "public, max-age=0, stale-while-revalidate=120, stale-if-error=300",
      },
    });
  } catch (error) {
    console.error(`API route error for product slug ${slug}:`, error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};