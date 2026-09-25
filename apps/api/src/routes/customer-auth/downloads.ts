// Signed-in buyer download and licence-key routes (list, ticket mint, key
// reveal). Mounted by ./index.ts; empty until B3 (Wave B design §7.1).
import { OpenAPIHono } from "@hono/zod-openapi";

const app = new OpenAPIHono<{ Bindings: Env }>();

export { app as customerDownloadRoutes };
