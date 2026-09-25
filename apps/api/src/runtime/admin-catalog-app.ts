import { createAdminRuntimeApiApp } from "./admin-base-app";
import { adminAttributesRoutes } from "../routes/admin/attributes";
import { adminCatalogProjectionRoutes } from "../routes/admin/catalog-projections";
import { adminCategoryRoutes } from "../routes/admin/categories";
import { adminBrandRoutes } from "../routes/admin/brands";
import { adminCollectionRoutes } from "../routes/admin/collections";
import { adminInventoryRoutes } from "../routes/admin/inventory";
import { adminMediaRoutes } from "../routes/admin/media";
import { adminProductsRoutes } from "../routes/admin/products";
import { adminReviewRoutes } from "../routes/admin/reviews";
import {
  adminDigitalAssetRoutes,
  adminDigitalEntitlementRoutes,
  adminProductDigitalAssetRoutes,
} from "../routes/admin/digital-assets";
import { adminWarrantyPolicyRoutes } from "../routes/admin/warranty-policies";

const app = createAdminRuntimeApiApp();
app.route("/admin/categories", adminCategoryRoutes);
app.route("/admin/brands", adminBrandRoutes);
app.route("/admin/collections", adminCollectionRoutes);
app.route("/admin/media", adminMediaRoutes);
app.route("/admin/inventory", adminInventoryRoutes);
app.route("/admin/products", adminProductsRoutes);
app.route("/admin/products", adminProductDigitalAssetRoutes);
app.route("/admin/attributes", adminAttributesRoutes);
app.route("/admin/catalog", adminCatalogProjectionRoutes);
app.route("/admin/reviews", adminReviewRoutes);
app.route("/admin/digital-assets", adminDigitalAssetRoutes);
app.route("/admin/digital-entitlements", adminDigitalEntitlementRoutes);
app.route("/admin/warranty-policies", adminWarrantyPolicyRoutes);

export default app;
