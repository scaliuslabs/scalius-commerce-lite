import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getLayoutData } from "@scalius/core/modules/storefront/storefront.service";

import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";
// Create an OpenAPIHono app for footer routes
const app = new OpenAPIHono<{ Bindings: Env }>();

// GET /footer — get footer data
const getFooterRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Footer"],
  summary: "Get footer configuration data",
  responses: {
    200: {
      description: "Footer configuration",
      content: { "application/json": { schema: successEnvelope(z.record(z.string(), z.unknown())) } },
    },
    404: errorResponses[404],
    500: errorResponses[500],
  }
});

app.openapi(getFooterRoute, async (c) => {
  const layout = await getLayoutData(c.get("db"), {
    credentialEncryptionKey: c.env.CREDENTIAL_ENCRYPTION_KEY,
  });
  return ok(c, layout.footer);
});

// Export the footer routes
export { app as footerRoutes };
