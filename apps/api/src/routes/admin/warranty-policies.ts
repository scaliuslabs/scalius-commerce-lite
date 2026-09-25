// Dashboard warranty-policy routes, mounted at /admin/warranty-policies (admin
// catalog family). Empty until B5 (Wave B design §7.2); permissions live in
// packages/core/src/auth/rbac/route-permissions/warranty.ts.
import { OpenAPIHono } from "@hono/zod-openapi";

const app = new OpenAPIHono<{ Bindings: Env }>();

export { app as adminWarrantyPolicyRoutes };
