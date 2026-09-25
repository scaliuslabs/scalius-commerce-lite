// Public product review routes (GET /products/{id}/reviews, keyset, cacheable
// under the cache generation). Mounted at /products after the product router
// (public catalog family); empty until B1 (Wave B design §7.1).
import { OpenAPIHono } from "@hono/zod-openapi";

const app = new OpenAPIHono<{ Bindings: Env }>();

export { app as productReviewRoutes };
