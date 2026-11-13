// Dashboard order routes, mounted at /admin/orders. Status, refund, invoice,
// support-request and return routers stay beside this folder; list, create,
// bulk and detail routes live in it. Mount order is route registration order,
// which is also the published OpenAPI path order: append new routers, do not
// reorder.

import { adminOrdersInvoiceRoutes } from "../orders-invoice";
import { adminOrdersRefundRoutes } from "../orders-refund";
import { adminOrdersReturnRoutes } from "../orders-returns";
import { adminOrdersStatusRoutes } from "../orders-status";
import { adminOrdersSupportRequestRoutes } from "../orders-support-requests";
import { adminOrderBulkRoutes } from "./bulk";
import { adminOrderCreateRoutes } from "./create";
import { adminOrderDetailRoutes } from "./detail";
import { adminOrderDigitalRoutes } from "./digital";
import { adminOrderDisputeRoutes } from "./disputes";
import { adminOrderFulfilmentRoutes } from "./fulfilments";
import { adminOrderListRoutes } from "./list";
import { adminOrderWarrantyClaimRoutes } from "./warranty-claims";
import { adminOrderUploadRoutes } from "./uploads";
import { adminRouter } from "../admin-router";

const app = adminRouter();

app.route("/", adminOrdersStatusRoutes);
app.route("/", adminOrdersRefundRoutes);
app.route("/", adminOrdersInvoiceRoutes);
app.route("/", adminOrdersSupportRequestRoutes);
app.route("/", adminOrdersReturnRoutes);
app.route("/", adminOrderListRoutes);
app.route("/", adminOrderCreateRoutes);
app.route("/", adminOrderBulkRoutes);
app.route("/", adminOrderDetailRoutes);
app.route("/", adminOrderFulfilmentRoutes);
app.route("/", adminOrderDigitalRoutes);
app.route("/", adminOrderWarrantyClaimRoutes);
app.route("/", adminOrderUploadRoutes);
app.route("/", adminOrderDisputeRoutes);

export { app as adminOrdersRoutes };
