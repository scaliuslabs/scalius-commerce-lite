// Staff opening a warranty claim from an order (POST /admin/orders/{id}/warranty-claims).
// Mounted by ./index.ts; empty until B5 (Wave B design §5.2, §7.2). Permission:
// ORDERS_EDIT + CONVERSATIONS_REPLY in
// packages/core/src/auth/rbac/route-permissions/warranty.ts.
import { OpenAPIHono } from "@hono/zod-openapi";

const app = new OpenAPIHono<{ Bindings: Env }>();

export { app as adminOrderWarrantyClaimRoutes };
