// Guest order conversation routes (receipt proof in a header or body, never
// the URL). Mounted by ./index.ts; routes arrive with Wave A conversations.
import { OpenAPIHono } from "@hono/zod-openapi";

const app = new OpenAPIHono<{ Bindings: Env }>();

export { app as orderConversationRoutes };
