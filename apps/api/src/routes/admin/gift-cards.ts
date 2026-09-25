// Dashboard gift-card routes, mounted at /admin/gift-cards (admin sales family).
// Empty until B4 (Wave B design §7.2); permissions live in
// packages/core/src/auth/rbac/route-permissions/gift-cards.ts.
import { OpenAPIHono } from "@hono/zod-openapi";

const app = new OpenAPIHono<{ Bindings: Env }>();

export { app as adminGiftCardRoutes };
