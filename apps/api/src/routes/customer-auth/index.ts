// Customer account routes, mounted at /customer-auth. Each file owns one
// account flow. Mount order is route registration order, which is also the
// published OpenAPI path order: append new routers, do not reorder.
import { OpenAPIHono } from "@hono/zod-openapi";
import { customerConversationRoutes } from "./conversations";
import { customerOrderListRoutes } from "./order-list";
import { customerOrderRoutes } from "./orders";
import { customerPhoneRoutes } from "./phone";
import { customerProfileRoutes } from "./profile";
import { customerSessionRoutes } from "./session";

const app = new OpenAPIHono<{ Bindings: Env }>();

app.route("/", customerSessionRoutes);
app.route("/", customerProfileRoutes);
app.route("/", customerOrderListRoutes);
app.route("/", customerPhoneRoutes);
app.route("/", customerOrderRoutes);
app.route("/", customerConversationRoutes);

export { app as customerAuthRoutes };
