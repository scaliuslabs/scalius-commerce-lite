import { createAdminRuntimeApiApp } from "./admin-base-app";
import { adminCustomerRoutes } from "../routes/admin/customers";
import { adminCustomerMarketingRoutes } from "../routes/admin/customer-marketing";
import { adminDiscountRoutes } from "../routes/admin/discounts";
import { adminConversationRoutes } from "../routes/admin/conversations";
import { adminOrdersRoutes } from "../routes/admin/orders";
import { adminShipmentRoutes } from "../routes/admin/shipments";
import { adminTaxRoutes } from "../routes/admin/taxes";
import { adminGiftCardRoutes } from "../routes/admin/gift-cards";
import { adminWarrantyClaimRoutes } from "../routes/admin/warranty-claims";
import { adminResourceRoutes } from "../routes/admin/resources";
import { adminResourceBulkRoutes } from "../routes/admin/resources-bulk";
import { adminResourceGiftCardRoutes } from "../routes/admin/resources-gift-cards";
import { adminResourceProductRoutes } from "../routes/admin/resources-products";
import { adminResourceWebhookRoutes } from "../routes/admin/resources-webhooks";

const app = createAdminRuntimeApiApp();
app.route("/admin/customers", adminCustomerMarketingRoutes);
app.route("/admin/customers", adminCustomerRoutes);
app.route("/admin/discounts", adminDiscountRoutes);
app.route("/admin/shipments", adminShipmentRoutes);
app.route("/admin/orders", adminOrdersRoutes);
app.route("/admin/conversations", adminConversationRoutes);
app.route("/admin/taxes", adminTaxRoutes);
app.route("/admin/gift-cards", adminGiftCardRoutes);
app.route("/admin/warranty-claims", adminWarrantyClaimRoutes);
// The stable app API's resources (orders, products, customers and their parts).
app.route("/admin/resources", adminResourceRoutes);
// Bulk runs of prices, stock, tags, status and publishing (routes/admin/resources-bulk.ts).
app.route("/admin/resources", adminResourceBulkRoutes);
// Gift cards, PIM product writes and an app's own webhook subscriptions.
app.route("/admin/resources", adminResourceGiftCardRoutes);
app.route("/admin/resources", adminResourceProductRoutes);
app.route("/admin/resources", adminResourceWebhookRoutes);

export default app;
