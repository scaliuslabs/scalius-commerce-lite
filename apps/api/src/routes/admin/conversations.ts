// Dashboard inbox routes, mounted at /admin/conversations. Routes arrive with
// Wave A conversations; the first one must also add "conversations" to the
// sales segments in runtime/admin-app.ts (the route-family parity test fails
// until it does).
import { OpenAPIHono } from "@hono/zod-openapi";

const app = new OpenAPIHono<{ Bindings: Env }>();

export { app as adminConversationRoutes };
