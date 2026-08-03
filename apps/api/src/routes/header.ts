import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getLayoutData } from "@scalius/core/modules/storefront/storefront.service";

import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";
// Create an OpenAPIHono app for header routes
const app = new OpenAPIHono<{ Bindings: Env }>();

// GET /header — get header data
const getHeaderRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Header"],
  summary: "Get header configuration data",
  responses: {
    200: {
      description: "Header configuration",
      content: { "application/json": { schema: successEnvelope(z.object({
        header: z.record(z.string(), z.unknown()),
      })) } },
    },
    404: errorResponses[404],
    500: errorResponses[500],
  }
});

app.openapi(getHeaderRoute, async (c) => {
  const layout = await getLayoutData(c.get("db"), {
    credentialEncryptionKey: c.env.CREDENTIAL_ENCRYPTION_KEY,
  });
  return ok(c, {
    header: { ...layout.header, navigation: layout.navigation },
  });
});

// Export the header routes
export { app as headerRoutes };
