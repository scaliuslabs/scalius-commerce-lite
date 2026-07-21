import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { articleRoutes } from "./articles";

describe("public articles contract", () => {
  it("exposes only published article listing and slug lookup", () => {
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
    app.route("/articles", articleRoutes);
    const spec = app.getOpenAPIDocument({
      openapi: "3.0.0",
      info: { title: "Articles", version: "1.0.0" },
    }) as unknown as {
      paths?: Record<
        string,
        Record<
          string,
          {
            summary?: string;
            parameters?: Array<{ name?: string }>;
          }
        >
      >;
    };

    expect(spec.paths?.["/api/v1/articles"]?.get?.summary).toBe(
      "List published articles newest first",
    );
    expect(
      spec.paths?.["/api/v1/articles"]?.get?.parameters?.map(
        (parameter) => parameter.name,
      ),
    ).toEqual(["limit", "page", "tag"]);
    expect(spec.paths?.["/api/v1/articles/slug/{slug}"]?.get?.summary).toBe(
      "Get a published article by slug",
    );
  });
});
