// Customer account routes, mounted at /customer-auth. Each file owns one
// account flow. Mount order is route registration order, which is also the
// published OpenAPI path order: append new routers, do not reorder.
import { OpenAPIHono } from "@hono/zod-openapi";
import { customerAccountSummaryRoutes } from "./account-summary";
import { customerAddressRoutes } from "./addresses";
import { customerConversationRoutes } from "./conversations";
import { customerDownloadRoutes } from "./downloads";
import { customerGiftCardRoutes } from "./gift-cards";
import { customerIdentityRoutes } from "./identity";
import { customerMarketingRoutes } from "./marketing";
import { customerOrderListRoutes } from "./order-list";
import { customerOrderRoutes } from "./orders";
import { customerPhoneRoutes } from "./phone";
import { customerProfileRoutes } from "./profile";
import { customerPushRoutes } from "./push";
import { customerReviewRoutes } from "./reviews";
import { customerSessionRoutes } from "./session";
import { customerWarrantyRoutes } from "./warranties";

const app = new OpenAPIHono<{ Bindings: Env }>();

app.route("/", customerSessionRoutes);
app.route("/", customerProfileRoutes);
app.route("/", customerOrderListRoutes);
app.route("/", customerPhoneRoutes);
app.route("/", customerOrderRoutes);
app.route("/", customerConversationRoutes);
app.route("/", customerAccountSummaryRoutes);
app.route("/", customerReviewRoutes);
app.route("/", customerDownloadRoutes);
app.route("/", customerGiftCardRoutes);
app.route("/", customerWarrantyRoutes);
app.route("/", customerMarketingRoutes);
app.route("/", customerAddressRoutes);
app.route("/", customerPushRoutes);
app.route("/", customerIdentityRoutes);

export { app as customerAuthRoutes };
