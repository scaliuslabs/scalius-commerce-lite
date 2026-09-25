import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  CUSTOMER_REQUEST_INTRO_MAX_LENGTH,
  getCustomerRequestIntro,
  getCustomerRequestPolicyPreview,
} from "@scalius/core/modules/settings/browser";
import { getCustomerRequestPolicyDocument, saveCustomerRequestPolicy } from "@scalius/core/modules/settings";

import { ok } from "../../../utils/api-response";
import { conflictResponse, errorResponses, successEnvelope } from "../../../schemas/responses";

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
  revision: z.number().int().nonnegative(),
  resolvedIntro: z.string(),
  preview: z.array(z.object({
    id: z.enum(["pre_shipment", "shipped_unpaid", "delivered_paid"]),
    label: z.string(),
    context: z.string(),
    actions: z.array(customerRequestActionSchema),
  })),
});

function buildPolicyPayload({ policy, revision }: {
  policy: z.infer<typeof customerRequestPolicySchema>;
  revision: number;
}) {
  return {
    policy,
    revision,
    resolvedIntro: getCustomerRequestIntro(policy),
    preview: getCustomerRequestPolicyPreview(policy),
  };
}

const getCustomerRequestPolicyRoute = createRoute({
  method: "get",
  path: "/customer-requests",
  operationId: "dashboard.customer_requests.policy_get",
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
  return ok(c, buildPolicyPayload(await getCustomerRequestPolicyDocument(c.get("db"))));
});

const saveCustomerRequestPolicyRoute = createRoute({
  method: "put",
  path: "/customer-requests",
  operationId: "dashboard.customer_requests.policy_update",
  tags: ["Admin - Settings"],
  summary: "Save operational customer request policy",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: customerRequestPolicySchema.extend({
            expectedRevision: z.number().int().nonnegative(),
          }).strict(),
        },
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
    409: conflictResponse,
  },
});

app.openapi(saveCustomerRequestPolicyRoute, async (c) => {
  const { expectedRevision, ...policy } = c.req.valid("json");
  return ok(c, buildPolicyPayload(
    await saveCustomerRequestPolicy(c.get("db"), policy, { expectedRevision }),
  ));
});

export { app as customerRequestPolicyRoutes };
