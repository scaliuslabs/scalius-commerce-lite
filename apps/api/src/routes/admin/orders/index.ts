// Dashboard order routes, mounted at /admin/orders. Status, refund, invoice,
// support-request and return routers stay beside this folder; list, create,
// bulk and detail routes live in it. Mount order is route registration order,
// which is also the published OpenAPI path order: append new routers, do not
// reorder.
import { OpenAPIHono } from "@hono/zod-openapi";
import { adminOrdersInvoiceRoutes } from "../orders-invoice";
import { adminOrdersRefundRoutes } from "../orders-refund";
import { adminOrdersReturnRoutes } from "../orders-returns";
import { adminOrdersStatusRoutes } from "../orders-status";
import { adminOrdersSupportRequestRoutes } from "../orders-support-requests";
import { adminOrderBulkRoutes } from "./bulk";
import { adminOrderCreateRoutes } from "./create";
import { adminOrderDetailRoutes } from "./detail";
import { adminOrderListRoutes } from "./list";

const app = new OpenAPIHono<{ Bindings: Env }>();

app.route("/", adminOrdersStatusRoutes);
app.route("/", adminOrdersRefundRoutes);
app.route("/", adminOrdersInvoiceRoutes);
app.route("/", adminOrdersSupportRequestRoutes);
app.route("/", adminOrdersReturnRoutes);
app.route("/", adminOrderListRoutes);
app.route("/", adminOrderCreateRoutes);
app.route("/", adminOrderBulkRoutes);
app.route("/", adminOrderDetailRoutes);

export { app as adminOrdersRoutes };
