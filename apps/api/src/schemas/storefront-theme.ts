import "@hono/zod-openapi";
import { buildStorefrontThemeDocumentSchemas, storeShapeSchema } from "@scalius/shared/storefront-theme";
import { namedSharedSchema } from "./responses";

/**
 * The shared, strict storefront theme document (version 7) as named OpenAPI
 * components: the document, its section list and its landing page, each
 * stated once in the contract and referred to everywhere else (the homepage
 * and every landing page share one section list).
 */
const themeDocumentParts = buildStorefrontThemeDocumentSchemas((name, schema) => namedSharedSchema(schema, name));

export const storefrontThemeDocumentApiSchema = namedSharedSchema(themeDocumentParts.document, "StorefrontThemeDocument");
/** The homepage's (or a landing page's) sections. */
export const storefrontSectionListApiSchema = themeDocumentParts.sections;
/** One landing page: its title, description and sections. */
export const storefrontLandingPageApiSchema = themeDocumentParts.landingPage;

/**
 * The store facts the theme fit rules read (bounded counts and the header
 * menu shape), served beside the theme so the storefront and the dashboard
 * resolve the document against the same facts. Named through
 * `namedSharedSchema`: a shared schema can exist before the OpenAPI extension
 * (route families load lazily), and zod 4 gives `.openapi` only to schemas
 * created after it.
 */
export const storeShapeApiSchema = namedSharedSchema(storeShapeSchema, "StorefrontStoreShape");
