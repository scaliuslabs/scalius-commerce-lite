import { ADMIN_MIDDLEWARE } from "./admin-base-app";
import { buildRouteGroupApp, type RouteGroupParts } from "./route-groups";
import { adminCustomerRoutes } from "../routes/admin/customers";
import { adminCustomerMarketingRoutes } from "../routes/admin/customer-marketing";
import { adminDiscountRoutes } from "../routes/admin/discounts";
import { adminConversationRoutes } from "../routes/admin/conversations";
import { adminOrdersRoutes } from "../routes/admin/orders";
import { adminTaxRoutes } from "../routes/admin/taxes";
import { adminGiftCardRoutes } from "../routes/admin/gift-cards";
import { adminWarrantyClaimRoutes } from "../routes/admin/warranty-claims";
import { adminResourceRoutes } from "../routes/admin/resources";
import { adminResourceBulkRoutes } from "../routes/admin/resources-bulk";
import { adminResourceGiftCardRoutes } from "../routes/admin/resources-gift-cards";
import { adminResourceProductRoutes } from "../routes/admin/resources-products";
import { adminResourceWebhookRoutes } from "../routes/admin/resources-webhooks";

export const adminSalesParts: RouteGroupParts<"admin-sales"> = {
  routers: {
    adminResourceRoutes,
    adminResourceBulkRoutes,
    adminResourceGiftCardRoutes,
    adminResourceProductRoutes,
    adminResourceWebhookRoutes,
    adminCustomerMarketingRoutes,
    adminCustomerRoutes,
    adminDiscountRoutes,
    adminOrdersRoutes,
    adminConversationRoutes,
    adminTaxRoutes,
    adminGiftCardRoutes,
    adminWarrantyClaimRoutes,
  },
  middleware: ADMIN_MIDDLEWARE,
};

export default buildRouteGroupApp("admin-sales", adminSalesParts);
