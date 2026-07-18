import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { pagesRoutes } from "./pages";

describe("public pages contract", () => {
  it("does not expose an admin-controlled publishedOnly escape hatch", () => {
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
    app.route("/pages", pagesRoutes);
    const spec = app.getOpenAPIDocument({
      openapi: "3.0.0",
      info: { title: "Pages", version: "1.0.0" },
    }) as unknown as {
      paths?: Record<string, Record<string, {
        summary?: string;
        parameters?: Array<{ name?: string }>;
      }>>;
    };

    const operation = spec.paths?.["/api/v1/pages"]?.get;
    expect(operation?.summary).toBe("List published pages with pagination");
    expect(operation?.parameters?.map((parameter) => parameter.name)).toEqual([
      "limit",
      "page",
      "sort",
    ]);
  });
});
