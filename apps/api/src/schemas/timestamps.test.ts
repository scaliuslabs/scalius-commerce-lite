import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import { nullableTimestampSchema } from "./timestamps";

describe("nullable timestamp OpenAPI contract", () => {
  it("documents null without degrading generated clients to unknown", () => {
    const app = new OpenAPIHono();
    app.openapi(
      createRoute({
        method: "get",
        path: "/timestamp",
        responses: {
          200: {
            description: "Timestamp",
            content: {
              "application/json": {
                schema: z.object({ value: nullableTimestampSchema }),
              },
            },
          },
        },
      }),
      (c) => c.json({ value: null }),
    );

    const document = app.getOpenAPIDocument({
      openapi: "3.0.0",
      info: { title: "Timestamp schema", version: "test" },
    });
    const schema = document.paths["/timestamp"]?.get?.responses?.[200]?.content?.[
      "application/json"
    ]?.schema as {
      properties?: Record<string, unknown>;
    };

    expect(schema.properties?.value).toEqual({
      $ref: "#/components/schemas/NullableTimestamp",
    });
    expect(document.components?.schemas?.NullableTimestamp).toEqual({
      anyOf: [{ type: "string" }, { type: "number" }],
      nullable: true,
      type: "string",
    });
  });
});
