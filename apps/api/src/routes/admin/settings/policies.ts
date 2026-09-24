import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  STORE_POLICY_KINDS,
  getStorePolicies,
  saveStorePolicies,
} from "@scalius/core/modules/settings/store-policies.service";

import { ok } from "../../../utils/api-response";
import { bumpCacheGeneration } from "../../../utils/cache-generation";
import { conflictResponse, errorResponses, successEnvelope } from "../../../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();

const pageIdSchema = z.string().trim().min(1).max(64).nullable();
const policiesSchema = z.object(
  Object.fromEntries(STORE_POLICY_KINDS.map((kind) => [kind, pageIdSchema])) as Record<
    (typeof STORE_POLICY_KINDS)[number],
    typeof pageIdSchema
  >,
);
const policiesPayloadSchema = policiesSchema.extend({ revision: z.number().int().nonnegative() });

const getPoliciesRoute = createRoute({
  method: "get",
  path: "/policies",
  operationId: "dashboard.policies.get",
  tags: ["Admin - Settings"],
  summary: "Get store policy pages",
  description: "Which of the store's content pages is its return and refund, privacy, terms of service, shipping and contact policy (page ids; null when not set).",
  responses: {
    200: { description: "Store policy pages", content: { "application/json": { schema: successEnvelope(policiesPayloadSchema) } } },
    ...errorResponses,
  },
});

app.openapi(getPoliciesRoute, async (c) => ok(c, await getStorePolicies(c.get("db"))));

const savePoliciesRoute = createRoute({
  method: "put",
  path: "/policies",
  operationId: "dashboard.policies.update",
  tags: ["Admin - Settings"],
  summary: "Link store policies to pages",
  description: "Links each policy to one of the store's own content pages, or clears it. Unknown or trashed pages are refused against their field.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: policiesSchema.partial().extend({ expectedRevision: z.number().int().nonnegative() }).strict(),
        },
      },
    },
  },
  responses: {
    200: { description: "Store policy pages saved", content: { "application/json": { schema: successEnvelope(policiesPayloadSchema) } } },
    ...errorResponses,
    409: conflictResponse,
  },
});

app.openapi(savePoliciesRoute, async (c) => {
  const { expectedRevision, ...patch } = c.req.valid("json");
  const saved = await saveStorePolicies(c.get("db"), patch, { expectedRevision });
  // The storefront footer and checkout link these pages.
  await bumpCacheGeneration(c);
  return ok(c, saved);
});

export { app as storePoliciesRoutes };
