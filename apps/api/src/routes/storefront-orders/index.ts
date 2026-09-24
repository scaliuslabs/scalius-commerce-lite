// Storefront order routes, mounted at /orders. Each file owns one buyer flow.
// Mount order is route registration order, which is also the published
// OpenAPI path order: append new routers, do not reorder.
import { OpenAPIHono } from "@hono/zod-openapi";
import { cartValidationRoutes } from "./cart-validation";
import { checkoutRoutes } from "./checkout";
import { orderConversationRoutes } from "./conversation";
import { paymentRecoveryRoutes } from "./payment-recovery";
import { receiptRoutes } from "./receipt";
import { checkoutStatusRoutes } from "./status";
import { receiptSupportRequestRoutes } from "./support-requests";
import { taxQuoteRoutes } from "./tax-quote";

const app = new OpenAPIHono<{ Bindings: Env }>();

app.route("/", checkoutStatusRoutes);
app.route("/", paymentRecoveryRoutes);
app.route("/", receiptRoutes);
app.route("/", receiptSupportRequestRoutes);
app.route("/", cartValidationRoutes);
app.route("/", taxQuoteRoutes);
app.route("/", checkoutRoutes);
app.route("/", orderConversationRoutes);

export { app as orderRoutes };
