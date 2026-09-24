import { storeShapeSchema, storefrontThemeDocumentSchema } from "@scalius/shared/storefront-theme";

/**
 * The shared, strict storefront theme document (version 4) as one named
 * OpenAPI component. Every theme request body and response uses it.
 */
export const storefrontThemeDocumentApiSchema = storefrontThemeDocumentSchema.openapi(
  "StorefrontThemeDocument",
);

/**
 * The store facts the theme fit rules read (bounded counts and the header
 * menu shape), served beside the theme so the storefront and the dashboard
 * resolve the document against the same facts.
 */
export const storeShapeApiSchema = storeShapeSchema.openapi("StorefrontStoreShape");
