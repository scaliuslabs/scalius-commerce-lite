// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

// Astro's middleware helpers, as Astro runs them: each handler gets the
// context and a `next` that runs the rest of the sequence.
vi.mock("astro:middleware", () => ({
  defineMiddleware: (handler: unknown) => handler,
  sequence: (...handlers: Array<(context: unknown, next: () => Promise<Response>) => Promise<Response> | Response>) =>
    (context: unknown, next: () => Promise<Response>) => {
      const run = (index: number): Promise<Response> => index === handlers.length
        ? next()
        : Promise.resolve(handlers[index]!(context, () => run(index + 1)));
      return run(0);
    },
}));

const layoutReads = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/api/storefront", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getLayoutData: () => {
    layoutReads.count += 1;
    return Promise.resolve(null);
  },
}));

describe("catalog redirects in the middleware", () => {
  it("answers a URL-only listing redirect before the layout read starts", async () => {
    const { onRequest } = await import("@/middleware");
    const url = new URL("https://shop.example.test/categories/bags?minPrice=&maxPrice=");
    const request = new Request(url);
    const page = vi.fn(async () => new Response("page"));
    const response = await (onRequest as unknown as (context: object, next: () => Promise<Response>) => Promise<Response>)(
      { request, url, routePattern: "/categories/[slug]", locals: {} },
      page,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/categories/bags");
    expect(response.headers.get("X-Cache-Status")).toBe("BYPASS");
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache, no-store, must-revalidate");
    expect(page).not.toHaveBeenCalled();
    expect(layoutReads.count).toBe(0);

    // A clean listing URL renders, and its layout read starts in the middleware.
    const clean = new URL("https://shop.example.test/categories/bags?page=2");
    await (onRequest as unknown as (context: object, next: () => Promise<Response>) => Promise<Response>)(
      { request: new Request(clean), url: clean, routePattern: "/categories/[slug]", locals: {} },
      page,
    ).catch(() => undefined);
    expect(page).toHaveBeenCalledTimes(1);
    expect(layoutReads.count).toBeGreaterThan(0);
  });
});
