// Signed-in buyer gift-card routes (list, save to account, reveal). Mounted by
// ./index.ts; empty until B4 (Wave B design §7.1).
import { OpenAPIHono } from "@hono/zod-openapi";

const app = new OpenAPIHono<{ Bindings: Env }>();

export { app as customerGiftCardRoutes };
