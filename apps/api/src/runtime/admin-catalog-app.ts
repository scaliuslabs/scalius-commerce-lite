import { createAdminRuntimeApiApp } from "./admin-base-app";
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

const app = createAdminRuntimeApiApp();
app.route("/admin/categories", adminCategoryRoutes);
app.route("/admin/brands", adminBrandRoutes);
app.route("/admin/price-lists", adminPriceListRoutes);
app.route("/admin/collections", adminCollectionRoutes);
app.route("/admin/media", adminMediaRoutes);
app.route("/admin/inventory/suppliers", adminSupplierRoutes);
app.route("/admin/inventory/purchase-orders", adminPurchaseOrderRoutes);
app.route("/admin/inventory/transfers", adminTransferRoutes);
app.route("/admin/inventory", adminInventoryRoutes);
app.route("/admin/products", adminProductsRoutes);
app.route("/admin/products", adminProductDigitalAssetRoutes);
app.route("/admin/attributes", adminAttributesRoutes);
app.route("/admin/catalog", adminCatalogProjectionRoutes);
app.route("/admin/reviews", adminReviewRoutes);
app.route("/admin/digital-assets", adminDigitalAssetRoutes);
app.route("/admin/digital-entitlements", adminDigitalEntitlementRoutes);
app.route("/admin/warranty-policies", adminWarrantyPolicyRoutes);
// Store migration: products, customers and inventory in one family.
app.route("/admin/import", adminImportRoutes);
app.route("/admin/export", adminExportRoutes);

export default app;
