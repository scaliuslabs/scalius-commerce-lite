// Public gift-card checkout routes (POST /checkout/gift-cards/apply and
// /balance; codes only in POST bodies). Mounted at /checkout/gift-cards (public
// config family); empty until B4 (Wave B design §4.3, §7.1).
import { OpenAPIHono } from "@hono/zod-openapi";

const app = new OpenAPIHono<{ Bindings: Env }>();

export { app as checkoutGiftCardRoutes };
