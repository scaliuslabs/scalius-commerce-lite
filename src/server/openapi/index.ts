// src/server/openapi/index.ts

import { openapiConfig } from "./openapi-config";
import { authPaths } from "./auth-paths";
import { productPaths } from "./product-paths";
import { categoryPaths } from "./category-paths";
import { collectionPaths } from "./collection-paths";
import { orderPaths } from "./order-paths";
import { otherPaths } from "./other-paths";
import { missingPaths } from "./missing-paths";
import { additionalPaths } from "./additional-paths";
import { attributePaths } from "./attribute-paths";
import { abandonedCheckoutPaths } from "./abandoned-checkout-paths";
import { metaConversionsPaths } from "./meta-conversions-paths"; // Import the new paths

// Combine all paths
const allPaths = {
  ...authPaths,
  ...productPaths,
  ...categoryPaths,
  ...collectionPaths,
  ...orderPaths,
  ...otherPaths,
  ...missingPaths,
  ...additionalPaths,
  ...attributePaths,
  ...abandonedCheckoutPaths,
  ...metaConversionsPaths, // Add the new paths
};

// Create the complete OpenAPI specification
export const openApiSpec = {
  ...openapiConfig,
  paths: allPaths,
};