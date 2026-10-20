import { ADMIN_MIDDLEWARE } from "./admin-base-app";
import { buildRouteGroupApp, type RouteGroupParts } from "./route-groups";
import { adminAttributesRoutes } from "../routes/admin/attributes";
import { adminCatalogProjectionRoutes } from "../routes/admin/catalog-projections";
import { adminCategoryRoutes } from "../routes/admin/categories";
import { adminBrandRoutes } from "../routes/admin/brands";
import { adminPriceListRoutes } from "../routes/admin/price-lists";
import { adminCollectionRoutes } from "../routes/admin/collections";
import { adminInventoryRoutes } from "../routes/admin/inventory";
import { adminPurchaseOrderRoutes, adminSupplierRoutes, adminTransferRoutes } from "../routes/admin/inventory-purchasing";
import { adminMediaRoutes } from "../routes/admin/media";
import { adminProductsRoutes } from "../routes/admin/products";
import { adminReviewRoutes } from "../routes/admin/reviews";
import { adminExportRoutes, adminImportRoutes } from "../routes/admin/store-transfer";
import {
  adminDigitalAssetRoutes,
  adminDigitalEntitlementRoutes,
  adminProductDigitalAssetRoutes,
} from "../routes/admin/digital-assets";
import { adminWarrantyPolicyRoutes } from "../routes/admin/warranty-policies";

export const adminCatalogParts: RouteGroupParts<"admin-catalog"> = {
  routers: {
    adminCategoryRoutes,
    adminBrandRoutes,
    adminPriceListRoutes,
    adminCollectionRoutes,
    adminMediaRoutes,
    adminSupplierRoutes,
    adminPurchaseOrderRoutes,
    adminTransferRoutes,
    adminInventoryRoutes,
    adminProductsRoutes,
    adminProductDigitalAssetRoutes,
    adminAttributesRoutes,
    adminCatalogProjectionRoutes,
    adminReviewRoutes,
    adminDigitalAssetRoutes,
    adminDigitalEntitlementRoutes,
    adminWarrantyPolicyRoutes,
    adminImportRoutes,
    adminExportRoutes,
  },
  middleware: ADMIN_MIDDLEWARE,
};

export default buildRouteGroupApp("admin-catalog", adminCatalogParts);
