// Dashboard warranty-claim routes, mounted at /admin/warranty-claims (admin
// sales family; Wave B design §5.2, §7.2). Permissions live in
// packages/core/src/auth/rbac/route-permissions/warranty.ts. A status change
// writes an event line in the claim thread (and an optional public reply) in
// the same batch; claims never move money, stock or order status. Claims are
// private and do not affect public cache dependencies.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { getWarrantyClaim, listWarrantyClaims, updateWarrantyClaim } from "@scalius/core/modules/warranty";
import { WARRANTY_CLAIM_STATUSES } from "@scalius/shared/warranty";
import { ok } from "../../utils/api-response";
import { conflictResponse, errorResponses, successEnvelope } from "../../schemas/responses";
import {
  presentStaffClaim,
  staffClaimUpdateBodySchema,
  staffWarrantyClaimSchema,
  warrantyClaimIdSchema,
} from "../../schemas/warranty";
import { UnauthorizedError } from "../../utils/api-error";

const app = new OpenAPIHono<{ Bindings: Env }>();

const TAG = "Admin - Warranty claims";
const claimParam = z.object({ id: warrantyClaimIdSchema });
const claimEnvelope = successEnvelope(z.object({ claim: staffWarrantyClaimSchema }));

function staffUserId(c: Context<{ Bindings: Env }>): string {
  const user = c.get("user") as { id?: string } | undefined;
  if (!user?.id) throw new UnauthorizedError("Sign in again to update claims.");
  return user.id;
}

function noStore(c: Context) {
  c.header("Cache-Control", "private, no-store");
}

app.openapi(createRoute({
  operationId: "dashboard.warranty_claims.list",
  method: "get",
  path: "/",
  tags: [TAG],
  summary: "Warranty claims, newest first (25 per page); by status or order",
  request: {
    query: z.object({
      status: z.enum(WARRANTY_CLAIM_STATUSES).optional(),
      orderId: z.string().trim().min(1).max(128).optional(),
      cursor: z.string().max(100).optional(),
    }),
  },
  responses: {
    200: {
      description: "Claims",
      content: { "application/json": { schema: successEnvelope(z.object({ items: z.array(staffWarrantyClaimSchema), nextCursor: z.string().nullable() })) } },
    },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  const page = await listWarrantyClaims(c.get("db"), c.req.valid("query"));
  const now = Math.floor(Date.now() / 1000);
  return ok(c, { items: page.items.map((claim) => presentStaffClaim(claim, now)), nextCursor: page.nextCursor });
});

app.openapi(createRoute({
  operationId: "dashboard.warranty_claims.get",
  method: "get",
  path: "/{id}",
  tags: [TAG],
  summary: "One claim with its warranty, the policy revision the buyer bought, the order and the item",
  request: { params: claimParam },
  responses: {
    200: { description: "The claim", content: { "application/json": { schema: claimEnvelope } } },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  return ok(c, { claim: presentStaffClaim(await getWarrantyClaim(c.get("db"), c.req.valid("param").id)) });
});

app.openapi(createRoute({
  operationId: "dashboard.warranty_claims.update",
  method: "patch",
  path: "/{id}",
  tags: [TAG],
  summary: "Move a claim (in progress, resolved with how, declined, reopened), optionally replying to the buyer",
  request: {
    params: claimParam,
    body: { required: true, content: { "application/json": { schema: staffClaimUpdateBodySchema } } },
  },
  responses: {
    200: { description: "The claim", content: { "application/json": { schema: claimEnvelope } } },
    ...errorResponses,
    409: conflictResponse,
  },
}), async (c) => {
  noStore(c);
  const body = c.req.valid("json");
  const claim = await updateWarrantyClaim(c.get("db"), c.req.valid("param").id, {
    version: body.version,
    status: body.status,
    resolution: body.resolution ?? null,
    message: body.message ?? null,
    requestKey: body.requestKey ?? null,
    staffUserId: staffUserId(c),
  }, { queue: c.env.JOBS_QUEUE });
  return ok(c, { claim: presentStaffClaim(claim) });
});

export { app as adminWarrantyClaimRoutes };
