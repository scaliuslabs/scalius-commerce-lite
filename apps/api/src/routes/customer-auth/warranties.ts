// Signed-in buyer warranty routes (list, open a claim). Mounted by ./index.ts;
// empty until B5 (Wave B design §7.1).
import { OpenAPIHono } from "@hono/zod-openapi";

const app = new OpenAPIHono<{ Bindings: Env }>();

export { app as customerWarrantyRoutes };
