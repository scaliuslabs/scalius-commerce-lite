import { storefrontThemeDocumentSchema } from "@scalius/shared/storefront-theme";

/**
 * The shared, strict storefront theme document (version 2) as one named
 * OpenAPI component. Every theme request body and response uses it.
 */
export const storefrontThemeDocumentApiSchema = storefrontThemeDocumentSchema.openapi(
  "StorefrontThemeDocument",
);
