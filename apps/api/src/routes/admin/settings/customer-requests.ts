import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  CUSTOMER_REQUEST_INTRO_MAX_LENGTH,
  getCustomerRequestIntro,
  getCustomerRequestPolicy,
  getCustomerRequestPolicyPreview,
  saveCustomerRequestPolicy,
} from "@scalius/core/modules/settings/customer-request-policy";

import { ok } from "../../../utils/api-response";
import { errorResponses, successEnvelope } from "../../../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();

const customerRequestPolicySchema = z.object({
  cancellationEnabled: z.boolean(),
  returnEnabled: z.boolean(),
  refundEnabled: z.boolean(),
  visibility: z.enum(["eligible_only", "show_unavailable"]),
  introText: z.string().trim().max(CUSTOMER_REQUEST_INTRO_MAX_LENGTH).nullable(),
}).strict();

const customerRequestActionSchema = z.object({
  type: z.enum(["cancel_pre_shipment", "return", "refund"]),
  label: z.string(),
  description: z.string(),
  eligible: z.boolean(),
  disabledReason: z.string().nullable(),
  visible: z.boolean(),
});

const customerRequestPolicyPayloadSchema = z.object({
  policy: customerRequestPolicySchema,
  resolvedIntro: z.string(),
  preview: z.array(z.object({
    id: z.enum(["pre_shipment", "shipped_unpaid", "delivered_paid"]),
    label: z.string(),
    context: z.string(),
    actions: z.array(customerRequestActionSchema),
  })),
});

function buildPolicyPayload(policy: z.infer<typeof customerRequestPolicySchema>) {
  return {
    policy,
    resolvedIntro: getCustomerRequestIntro(policy),
    preview: getCustomerRequestPolicyPreview(policy),
  };
}

const getCustomerRequestPolicyRoute = createRoute({
  method: "get",
  path: "/customer-requests",
  tags: ["Admin - Settings"],
  summary: "Get operational customer request policy",
  responses: {
    200: {
      description: "Operational customer cancellation, return, and refund policy",
      content: {
        "application/json": {
          schema: successEnvelope(customerRequestPolicyPayloadSchema),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(getCustomerRequestPolicyRoute, async (c) => {
  const policy = await getCustomerRequestPolicy(c.get("db"));
  return ok(c, buildPolicyPayload(policy));
});

const saveCustomerRequestPolicyRoute = createRoute({
  method: "put",
  path: "/customer-requests",
  tags: ["Admin - Settings"],
  summary: "Save operational customer request policy",
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: customerRequestPolicySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Operational customer request policy saved",
      content: {
        "application/json": {
          schema: successEnvelope(customerRequestPolicyPayloadSchema),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(saveCustomerRequestPolicyRoute, async (c) => {
  const policy = await saveCustomerRequestPolicy(c.get("db"), c.req.valid("json"));
  return ok(c, buildPolicyPayload(policy));
});

export { app as customerRequestPolicyRoutes };
