import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getLayoutData } from "@scalius/core/modules/storefront/storefront.service";

import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";
// Create an OpenAPIHono app for footer routes
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
const footerSchema = z.object({
  logo: z.object({ src: z.string(), alt: z.string() }),
  favicon: z.object({ src: z.string(), alt: z.string() }),
  tagline: z.string(),
  description: z.string(),
  copyrightText: z.string(),
  menus: z.array(z.object({
    id: z.string(),
    title: z.string(),
    links: z.array(navigationItemSchema),
  })),
  social: z.array(z.object({
    id: z.string(),
    label: z.string(),
    url: z.string(),
    iconUrl: z.string().optional(),
  })),
});

// GET /footer — get footer data
const getFooterRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "storefront.layout.footer_alias",
  tags: ["Footer"],
  summary: "Get footer configuration data",
  responses: {
    200: {
      description: "Footer configuration",
      content: { "application/json": { schema: successEnvelope(footerSchema) } },
    },
    404: errorResponses[404],
    500: errorResponses[500],
  }
});

app.openapi(getFooterRoute, async (c) => {
  const layout = await getLayoutData(c.get("db"), {
    credentialEncryptionKey: c.env.CREDENTIAL_ENCRYPTION_KEY,
  });
  return ok(c, footerSchema.parse(layout.footer));
});

// Export the footer routes
export { app as footerRoutes };
