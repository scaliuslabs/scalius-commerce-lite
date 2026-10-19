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

export default app;
