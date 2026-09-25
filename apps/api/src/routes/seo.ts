import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getSeoSettings } from "@scalius/core/modules/settings";
import {
  SEO_RETURN_POLICY_CATEGORIES,
  SEO_RETURN_POLICY_FEES,
  SEO_RETURN_POLICY_METHODS,
} from "@scalius/shared/seo-return-policy";

import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";
// Create an OpenAPIHono app for SEO routes
const app = new OpenAPIHono<{ Bindings: Env }>();

const discoverySchema = z.object({
  feeds: z.object({
    productCatalogEnabled: z.boolean(),
    includeUnavailableProducts: z.boolean(),
    variantStrategy: z.enum(["products", "variants"]),
    title: z.string(),
    description: z.string(),
  }),
});

const returnPolicySchema = z.object({
  enabled: z.boolean(),
  country: z.string(),
  category: z.enum(SEO_RETURN_POLICY_CATEGORIES),
  returnWindowDays: z.number().int().min(1).max(365).nullable(),
  returnFees: z.enum(SEO_RETURN_POLICY_FEES),
  returnMethod: z.enum(SEO_RETURN_POLICY_METHODS),
  policyUrl: z.string(),
});

// GET /seo — get SEO settings
const getSeoSettingsRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "storefront.seo.get",
  tags: ["SEO"],
  summary: "Get SEO settings",
  responses: {
    200: {
      description: "SEO settings",
      content: {
        "application/json": {
          schema: successEnvelope(
            z.object({
              homepageTitle: z.string(),
              homepageMetaDescription: z.string(),
              socialImage: z.string(),
              discovery: discoverySchema,
              returnPolicy: returnPolicySchema,
            }),
          ),
        },
      },
    },
    500: errorResponses[500],
  },
});

app.openapi(getSeoSettingsRoute, async (c) => {
  const db = c.get("db");
  const settings = await getSeoSettings(db);
  return ok(c, settings);
});

export { app as seoRoutes };
