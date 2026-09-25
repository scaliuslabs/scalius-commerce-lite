// Signed-in buyer review routes (my reviews, lines to review, submit, edit,
// withdraw). Mounted by ./index.ts; empty until B1 (Wave B design §7.1).
import { OpenAPIHono } from "@hono/zod-openapi";

const app = new OpenAPIHono<{ Bindings: Env }>();

export { app as customerReviewRoutes };
