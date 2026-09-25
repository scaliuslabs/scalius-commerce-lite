// Guest download routes (receipt downloads, ticket mint, key reveal) and the
// cookie-bound ticket stream /orders/downloads/{entitlementId}/{exp}/{sig}.
// Mounted by ./index.ts; empty until B3 (Wave B design §3.4, §7.1).
import { OpenAPIHono } from "@hono/zod-openapi";

const app = new OpenAPIHono<{ Bindings: Env }>();

export { app as receiptDownloadRoutes };
