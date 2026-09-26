// Dashboard warranty-policy routes, mounted at /admin/warranty-policies (admin
// catalog family; Wave B design §5.1, §7.2). Permissions live in
// packages/core/src/auth/rbac/route-permissions/warranty.ts. An edit makes the
// next immutable revision; archive hides a policy from buyers and the editor.
// Database triggers advance affected product-page dependencies in the write transaction.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  archiveWarrantyPolicy,
  createWarrantyPolicy,
  getWarrantyPolicy,
  listWarrantyPolicies,
  restoreWarrantyPolicy,
  updateWarrantyPolicy,
} from "@scalius/core/modules/warranty";
import { created, ok } from "../../utils/api-response";
import { conflictResponse, errorResponses, successEnvelope } from "../../schemas/responses";
import {
  presentWarrantyPolicy,
  warrantyPolicyBodySchema,
  warrantyPolicyIdSchema,
  warrantyPolicySchema,
  warrantyPolicyUpdateBodySchema,
} from "../../schemas/warranty";

const app = new OpenAPIHono<{ Bindings: Env }>();

const TAG = "Admin - Warranty policies";
const policyParam = z.object({ id: warrantyPolicyIdSchema });
const policyEnvelope = successEnvelope(z.object({ policy: warrantyPolicySchema }));
const writeResponses = { ...errorResponses, 409: conflictResponse };

function noStore(c: Context) {
  c.header("Cache-Control", "private, no-store");
}

app.openapi(createRoute({
  operationId: "dashboard.warranty_policies.list",
  method: "get",
  path: "/",
  tags: [TAG],
  summary: "Warranty policies by name, with how many products use each",
  request: {
    query: z.object({
      archived: z.enum(["include"]).optional().openapi({ description: "`include` lists archived policies too (after the live ones)" }),
    }),
  },
  responses: {
    200: { description: "Policies", content: { "application/json": { schema: successEnvelope(z.object({ items: z.array(warrantyPolicySchema) })) } } },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  const policies = await listWarrantyPolicies(c.get("db"), { includeArchived: c.req.valid("query").archived === "include" });
  return ok(c, { items: policies.map(presentWarrantyPolicy) });
});

app.openapi(createRoute({
  operationId: "dashboard.warranty_policies.get",
  method: "get",
  path: "/{id}",
  tags: [TAG],
  summary: "One warranty policy",
  request: { params: policyParam },
  responses: {
    200: { description: "The policy", content: { "application/json": { schema: policyEnvelope } } },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  return ok(c, { policy: presentWarrantyPolicy(await getWarrantyPolicy(c.get("db"), c.req.valid("param").id)) });
});

app.openapi(createRoute({
  operationId: "dashboard.warranty_policies.create",
  method: "post",
  path: "/",
  tags: [TAG],
  summary: "Add a warranty policy (its first revision)",
  request: { body: { required: true, content: { "application/json": { schema: warrantyPolicyBodySchema } } } },
  responses: {
    201: { description: "The new policy", content: { "application/json": { schema: policyEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  noStore(c);
  const policy = await createWarrantyPolicy(c.get("db"), c.req.valid("json"));
  return created(c, { policy: presentWarrantyPolicy(policy) });
});

app.openapi(createRoute({
  operationId: "dashboard.warranty_policies.update",
  method: "put",
  path: "/{id}",
  tags: [TAG],
  summary: "Edit a policy: a change makes the next revision (orders keep the one they bought)",
  request: {
    params: policyParam,
    body: { required: true, content: { "application/json": { schema: warrantyPolicyUpdateBodySchema } } },
  },
  responses: {
    200: { description: "The policy", content: { "application/json": { schema: policyEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  noStore(c);
  const policy = await updateWarrantyPolicy(c.get("db"), c.req.valid("param").id, c.req.valid("json"));

  return ok(c, { policy: presentWarrantyPolicy(policy) });
});

app.openapi(createRoute({
  operationId: "dashboard.warranty_policies.archive",
  method: "delete",
  path: "/{id}",
  tags: [TAG],
  summary: "Archive a policy: buyers stop seeing it and new orders stop freezing it (orders keep theirs)",
  request: { params: policyParam },
  responses: {
    200: { description: "The archived policy", content: { "application/json": { schema: policyEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  noStore(c);
  const policy = await archiveWarrantyPolicy(c.get("db"), c.req.valid("param").id);

  return ok(c, { policy: presentWarrantyPolicy(policy) });
});

app.openapi(createRoute({
  operationId: "dashboard.warranty_policies.restore",
  method: "post",
  path: "/{id}/restore",
  tags: [TAG],
  summary: "Restore an archived policy; products still using it show it again",
  request: { params: policyParam },
  responses: {
    200: { description: "The restored policy", content: { "application/json": { schema: policyEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  noStore(c);
  const policy = await restoreWarrantyPolicy(c.get("db"), c.req.valid("param").id);

  return ok(c, { policy: presentWarrantyPolicy(policy) });
});

export { app as adminWarrantyPolicyRoutes };
