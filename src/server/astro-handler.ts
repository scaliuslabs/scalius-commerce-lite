// src/server/astro-handler.ts
import type { APIContext as BaseAPIContext } from "astro";
// ✅ CORRECTED: Directly import the ExecutionContext type.
import type { ExecutionContext } from "@cloudflare/workers-types";
import app from "./index";
import { invalidateCacheWithRelationships } from "./utils/cache-invalidation";

export const prerender = false;

type APIContextWithLocals = BaseAPIContext & {
  locals: {
    runtime: {
      env: Env;
      ctx: ExecutionContext;
    };
    [key: string]: any;
  };
};

// Universal request handler for all HTTP methods
async function handleRequest(context: APIContextWithLocals) {
  const startTime = performance.now();

  try {
    const runtime = context.locals.runtime;

    if (!runtime || !runtime.env || !runtime.ctx) {
      console.error(
        "FATAL: Cloudflare runtime environment not found in Astro context. Check your Astro adapter configuration and middleware.",
      );
      return new Response(
        JSON.stringify({ error: "Server configuration error" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    const url = new URL(context.request.url);
    let path;

    if (url.pathname === "/api/__ptproxy") {
      path = "/__ptproxy";
    } else {
      path = url.pathname.replace(/^\/api\/v1/, "");
    }

    if (path === "") path = "/";
    else if (!path.startsWith("/")) path = "/" + path;

    const newUrl = new URL(path, url.origin);
    url.searchParams.forEach((value, key) => {
      newUrl.searchParams.append(key, value);
    });

    const newRequest = new Request(newUrl.toString(), {
      method: context.request.method,
      headers: context.request.headers,
      body:
        context.request.method !== "GET" && context.request.method !== "HEAD"
          ? await context.request.arrayBuffer()
          : undefined,
      redirect: "manual",
    });

    const response = await app.fetch(newRequest, runtime.env, runtime.ctx);

    const endTime = performance.now();
    const responseTime = endTime - startTime;

    if (process.env.NODE_ENV === "production" && responseTime > 1000) {
      console.warn(
        `Slow API response: ${context.request.method} ${context.request.url} took ${responseTime.toFixed(2)}ms`,
      );
    }

    return response;
  } catch (error) {
    console.error("API handler error:", {
      url: context.request.url,
      method: context.request.method,
      error:
        error instanceof Error
          ? { message: error.message, stack: error.stack, name: error.name }
          : String(error),
    });

    const endTime = performance.now();
    const responseTime = endTime - startTime;
    console.error(`Error response time: ${responseTime.toFixed(2)}ms`);

    return new Response(
      JSON.stringify({
        error: "Internal Server Error",
        message:
          error instanceof Error ? error.message : "Unknown error occurred",
        requestId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}

// Separate functions for each method, all calling the main handler
export async function GET(context: BaseAPIContext) {
  return handleRequest(context as APIContextWithLocals);
}

export async function POST(context: BaseAPIContext) {
  const response = await handleRequest(context as APIContextWithLocals);
  await invalidateCacheForRequest(context, response);
  return response;
}

export async function PUT(context: BaseAPIContext) {
  const response = await handleRequest(context as APIContextWithLocals);
  await invalidateCacheForRequest(context, response);
  return response;
}

export async function DELETE(context: BaseAPIContext) {
  const response = await handleRequest(context as APIContextWithLocals);
  await invalidateCacheForRequest(context, response);
  return response;
}

export async function PATCH(context: BaseAPIContext) {
  return handleRequest(context as APIContextWithLocals);
}

export async function OPTIONS(context: BaseAPIContext) {
  return handleRequest(context as APIContextWithLocals);
}

async function invalidateCacheForRequest(
  context: BaseAPIContext,
  response: Response,
): Promise<void> {
  if (!response.ok) return;

  try {
    const url = new URL(context.request.url);
    const pathParts = url.pathname.split("/").filter(Boolean);

    if (pathParts.length < 3 || pathParts[0] !== "api" || pathParts[1] !== "v1") return;

    const resourceType = pathParts[2];
    if (!resourceType || resourceType === "cache") return;

    const validResourceTypes = [
      "products", "categories", "collections", "hero", "navigation", "pages", "footer", "header", "search"
    ];

    if (validResourceTypes.includes(resourceType)) {
      await invalidateCacheWithRelationships(resourceType);
    }
  } catch (error) {
    console.error("Error invalidating cache:", error);
  }
}