import { createAdminRuntimeApiApp } from "./admin-base-app";
import { adminCustomerRoutes } from "../routes/admin/customers";
import { adminDiscountRoutes } from "../routes/admin/discounts";
import { adminOrdersRoutes } from "../routes/admin/orders";
import { adminPromotionRoutes } from "../routes/admin/promotions";
import { adminShipmentRoutes } from "../routes/admin/shipments";
import { adminTaxRoutes } from "../routes/admin/taxes";

const app = createAdminRuntimeApiApp();
app.route("/admin/customers", adminCustomerRoutes);
app.route("/admin/discounts", adminDiscountRoutes);
app.route("/admin/promotions", adminPromotionRoutes);
app.route("/admin/shipments", adminShipmentRoutes);
app.route("/admin/orders", adminOrdersRoutes);
app.route("/admin/taxes", adminTaxRoutes);

export default app;
