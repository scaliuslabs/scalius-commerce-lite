import { createRuntimeApiApp } from "./base-app";
import { attributeRoutes } from "../routes/attributes";
import { categoryRoutes } from "../routes/categories";
import { collectionRoutes } from "../routes/collections";
import { serveMediaRoute } from "../routes/media-server";
import { productRoutes } from "../routes/products";
import { searchRoutes } from "../routes/search";

const app = createRuntimeApiApp();
app.route("/attributes", attributeRoutes);
app.route("/collections", collectionRoutes);
app.route("/search", searchRoutes);
app.route("/products", productRoutes);
app.route("/categories", categoryRoutes);
if (process.env.NODE_ENV === "development") app.route("/media", serveMediaRoute);

export default app;
