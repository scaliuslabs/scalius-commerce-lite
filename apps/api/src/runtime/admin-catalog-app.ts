import { createAdminRuntimeApiApp } from "./admin-base-app";
import { adminAttributesRoutes } from "../routes/admin/attributes";
import { adminCategoryRoutes } from "../routes/admin/categories";
import { adminCollectionRoutes } from "../routes/admin/collections";
import { adminInventoryRoutes } from "../routes/admin/inventory";
import { adminMediaRoutes } from "../routes/admin/media";
import { adminProductsRoutes } from "../routes/admin/products";

const app = createAdminRuntimeApiApp();
app.route("/admin/categories", adminCategoryRoutes);
app.route("/admin/collections", adminCollectionRoutes);
app.route("/admin/media", adminMediaRoutes);
app.route("/admin/inventory", adminInventoryRoutes);
app.route("/admin/products", adminProductsRoutes);
app.route("/admin/attributes", adminAttributesRoutes);

export default app;
