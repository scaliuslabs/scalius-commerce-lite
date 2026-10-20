import { buildRouteGroupApp, type RouteGroupParts } from "./route-groups";
import { attributeRoutes } from "../routes/attributes";
import { categoryRoutes } from "../routes/categories";
import { brandRoutes } from "../routes/brands";
import { collectionRoutes } from "../routes/collections";
import { serveMediaRoute } from "../routes/media-server";
import { productRoutes } from "../routes/products";
import { productReviewRoutes } from "../routes/product-reviews";
import { searchRoutes } from "../routes/search";

export const publicCatalogParts: RouteGroupParts<"public-catalog"> = {
  routers: {
    attributeRoutes,
    collectionRoutes,
    brandRoutes,
    searchRoutes,
    serveMediaRoute,
    productRoutes,
    productReviewRoutes,
    categoryRoutes,
  },
  middleware: {},
};

export default buildRouteGroupApp("public-catalog", publicCatalogParts);
