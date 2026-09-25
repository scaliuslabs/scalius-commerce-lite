// Staff opening a warranty claim from an order (POST /admin/orders/{id}/warranty-claims;
// Wave B design §5.2, §7.2). Mounted by ./index.ts. Permission: ORDERS_EDIT +
// CONVERSATIONS_REPLY in packages/core/src/auth/rbac/route-permissions/warranty.ts.
// Staff may open a goodwill claim on an expired warranty (never a voided one);
// the description posts as a public message from the store, which tells the
// buyer the claim exists.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { getWarrantyClaim, openWarrantyClaim } from "@scalius/core/modules/warranty";
import { created } from "../../../utils/api-response";
import { conflictResponse, errorResponses, successEnvelope } from "../../../schemas/responses";
import { presentStaffClaim, staffOpenClaimBodySchema, staffWarrantyClaimSchema } from "../../../schemas/warranty";
import { UnauthorizedError } from "../../../utils/api-error";

const app = new OpenAPIHono<{ Bindings: Env }>();

function staffUserId(c: Context<{ Bindings: Env }>): string {
  const user = c.get("user") as { id?: string } | undefined;
  if (!user?.id) throw new UnauthorizedError("Sign in again to open a claim.");
  return user.id;
}

app.openapi(createRoute({
  operationId: "dashboard.orders.warranty_claim_open",
  method: "post",
  path: "/{id}/warranty-claims",
  tags: ["Admin - Warranty claims"],
  summary: "Open a warranty claim for a line of this order (goodwill allowed after expiry)",
  request: {
    params: z.object({ id: z.string().trim().min(1).max(128) }),
    body: { required: true, content: { "application/json": { schema: staffOpenClaimBodySchema } } },
  },
  responses: {
    201: { description: "The claim", content: { "application/json": { schema: successEnvelope(z.object({ claim: staffWarrantyClaimSchema })) } } },
    ...errorResponses,
    409: conflictResponse,
  },
}), async (c) => {
  c.header("Cache-Control", "private, no-store");
  const orderId = c.req.valid("param").id;
  const body = c.req.valid("json");
  const db = c.get("db");
  const opened = await openWarrantyClaim(db, {
    warrantyId: body.warrantyId,
    actor: { kind: "staff", userId: staffUserId(c) },
    description: body.description,
    clientKey: body.requestKey,
    quantity: body.quantity,
    orderId,
  }, { queue: c.env.JOBS_QUEUE });
  return created(c, { claim: presentStaffClaim(await getWarrantyClaim(db, opened.claimId)) });
});

export { app as adminOrderWarrantyClaimRoutes };
