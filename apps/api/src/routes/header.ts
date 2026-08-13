import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getLayoutData } from "@scalius/core/modules/storefront/storefront.service";

import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";
// Create an OpenAPIHono app for header routes
const app = new OpenAPIHono<{ Bindings: Env }>();

const navigationLeafSchema = z.object({
  id: z.string().optional(),
  title: z.string(),
  href: z.string().optional(),
  openInNewTab: z.boolean().optional(),
});
const navigationChildSchema = navigationLeafSchema.extend({
  subMenu: z.array(navigationLeafSchema).optional(),
});
const navigationItemSchema = navigationLeafSchema.extend({
  subMenu: z.array(navigationChildSchema).optional(),
});
const headerSchema = z.object({
  topBar: z.object({ text: z.string(), isEnabled: z.boolean() }),
  logo: z.object({ src: z.string(), alt: z.string(), width: z.number().int() }),
  favicon: z.object({ src: z.string(), alt: z.string() }),
  contact: z.object({ phone: z.string(), text: z.string(), isEnabled: z.boolean() }),
  social: z.array(z.object({
    id: z.string(),
    label: z.string(),
    url: z.string(),
    iconUrl: z.string().optional(),
  })),
  navigation: z.array(navigationItemSchema),
});

// GET /header — get header data
const getHeaderRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "storefront.layout.header_alias",
  tags: ["Header"],
  summary: "Get header configuration data",
  responses: {
    200: {
      description: "Header configuration",
      content: { "application/json": { schema: successEnvelope(z.object({
        header: headerSchema,
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
    header: headerSchema.parse({ ...layout.header, navigation: layout.navigation }),
  });
});

// Export the header routes
export { app as headerRoutes };
