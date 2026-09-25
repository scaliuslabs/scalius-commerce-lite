// Guest review routes under /orders/receipt/{id}/reviews (receipt proof in a
// header). Mounted by ./index.ts; empty until B1 (Wave B design §7.1).
import { OpenAPIHono } from "@hono/zod-openapi";

const app = new OpenAPIHono<{ Bindings: Env }>();

export { app as receiptReviewRoutes };
