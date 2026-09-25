// Dashboard review moderation routes, mounted at /admin/reviews (admin catalog
// family). Empty until B1 (Wave B design §7.2); permissions live in
// packages/core/src/auth/rbac/route-permissions/reviews.ts. Staff actions bump
// the cache generation once per request.
import { OpenAPIHono } from "@hono/zod-openapi";

const app = new OpenAPIHono<{ Bindings: Env }>();

export { app as adminReviewRoutes };
