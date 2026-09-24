// Signed-in buyer conversation routes (store threads and order threads).
// Mounted by ./index.ts; routes arrive with Wave A conversations.
import { OpenAPIHono } from "@hono/zod-openapi";

const app = new OpenAPIHono<{ Bindings: Env }>();

export { app as customerConversationRoutes };
