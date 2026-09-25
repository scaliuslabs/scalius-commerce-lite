// Digital delivery actions on one order (POST /admin/orders/{id}/digital/resend).
// Mounted by ./index.ts; empty until B3 (Wave B design §3.5, §7.2). Permission:
// ORDERS_EDIT in packages/core/src/auth/rbac/route-permissions/digital.ts.
import { OpenAPIHono } from "@hono/zod-openapi";

const app = new OpenAPIHono<{ Bindings: Env }>();

export { app as adminOrderDigitalRoutes };
