import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { RouteConfig, RouteHandler } from "@hono/zod-openapi";
import {
  PRODUCT_FEED_ROW_PREVIEW_HARD_RESPONSE_BYTES,
  PRODUCT_FEED_ROW_PREVIEW_MAX_CURSOR_LENGTH,
  PRODUCT_FEED_ROW_PREVIEW_MAX_LIMIT,
  PRODUCT_FEED_ROW_PREVIEW_MAX_PRODUCT_ID_LENGTH,
  PRODUCT_FEED_ROW_PREVIEW_MAX_SKU_LENGTH,
  PRODUCT_FEED_ROW_PREVIEW_OMISSION_REASONS,
  PRODUCT_FEED_ROW_PREVIEW_RESPONSE_BUDGET_BYTES,
  executeProductFeedRowPreview,
  validateProductFeedRowPreviewCursor,
} from "@scalius/core/modules/products";
import {
  getCurrencySettings,
  getMediaOptimizationSettings,
  getSeoSettings,
} from "@scalius/core/modules/settings/site-settings.service";
import { ok } from "../../../utils/api-response";
import {
  errorResponses,
  successEnvelope,
} from "../../../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();
type AppRouteHandler<R extends RouteConfig> = RouteHandler<
  R,
  { Bindings: Env }
>;

const boundedResponseString = z
  .string()
  .max(PRODUCT_FEED_ROW_PREVIEW_HARD_RESPONSE_BYTES);
const productIdentitySchema = z.object({
  productId: z.string().max(PRODUCT_FEED_ROW_PREVIEW_MAX_PRODUCT_ID_LENGTH),
  variantId: z
    .string()
    .max(PRODUCT_FEED_ROW_PREVIEW_MAX_PRODUCT_ID_LENGTH)
    .nullable(),
  sku: z.string().max(PRODUCT_FEED_ROW_PREVIEW_MAX_SKU_LENGTH).nullable(),
});

const catalogFeedRowSchema = z.object({
  kind: z.enum(["product", "variant"]),
  productId: z.string().max(PRODUCT_FEED_ROW_PREVIEW_MAX_PRODUCT_ID_LENGTH),
  variantId: z
    .string()
    .max(PRODUCT_FEED_ROW_PREVIEW_MAX_PRODUCT_ID_LENGTH)
    .nullable(),
  id: boundedResponseString,
  title: boundedResponseString,
  description: boundedResponseString,
  link: boundedResponseString,
  imageLink: boundedResponseString,
  availability: z.object({
    canonical: z.enum(["in_stock", "out_of_stock"]),
    google: z.enum(["in_stock", "out_of_stock"]),
    meta: z.enum(["in stock", "out of stock"]),
  }),
  condition: z.enum(["new", "refurbished", "used"]).nullable(),
  pricing: z.object({
    currencyCode: z.string().max(3),
    originalAmount: z.number().finite(),
    currentAmount: z.number().finite(),
    price: boundedResponseString,
    salePrice: boundedResponseString.nullable(),
    currentPrice: boundedResponseString,
  }),
  brand: boundedResponseString.nullable(),
  gtin: boundedResponseString.nullable(),
  identifierExists: z.literal("no").nullable(),
  itemGroupId: boundedResponseString.nullable(),
  itemGroupTitle: boundedResponseString.nullable(),
  variantOptions: z
    .array(
      z.object({
        name: z.string().max(250),
        value: z.string().max(250),
      }),
    )
    .max(10),
  googleProductCategory: boundedResponseString.nullable(),
  facebookProductCategory: boundedResponseString.nullable(),
  productType: boundedResponseString.nullable(),
  standardAttributes: z
    .array(
      z.object({
        name: z.enum([
          "size",
          "color",
          "material",
          "pattern",
          "gender",
          "age_group",
        ]),
        value: boundedResponseString,
      }),
    )
    .max(260),
  shipping: z
    .object({
      country: z.literal("BD"),
      service: z.literal("Standard"),
      price: boundedResponseString,
    })
    .nullable(),
});

const emittedEntrySchema = productIdentitySchema.extend({
  status: z.literal("emitted"),
  row: catalogFeedRowSchema,
});
const omittedEntrySchema = productIdentitySchema.extend({
  status: z.literal("omitted"),
  reason: z.enum(PRODUCT_FEED_ROW_PREVIEW_OMISSION_REASONS),
});
const tooLargeEntrySchema = productIdentitySchema.extend({
  status: z.literal("preview_entry_too_large"),
  requiredBytes: z.number().int().nonnegative(),
});

export const productFeedRowPreviewResponseSchema = z.object({
  productId: z.string().max(PRODUCT_FEED_ROW_PREVIEW_MAX_PRODUCT_ID_LENGTH),
  requestedSku: z
    .string()
    .max(PRODUCT_FEED_ROW_PREVIEW_MAX_SKU_LENGTH)
    .nullable(),
  policy: z.object({
    productCatalogEnabled: z.boolean(),
    includeUnavailableProducts: z.boolean(),
    variantStrategy: z.enum(["products", "variants"]),
  }),
  entries: z
    .array(
      z.discriminatedUnion("status", [
        emittedEntrySchema,
        omittedEntrySchema,
        tooLargeEntrySchema,
      ]),
    )
    .max(PRODUCT_FEED_ROW_PREVIEW_MAX_LIMIT),
  pagination: z.object({
    limit: z.number().int().min(1).max(PRODUCT_FEED_ROW_PREVIEW_MAX_LIMIT),
    returned: z.number().int().nonnegative().max(PRODUCT_FEED_ROW_PREVIEW_MAX_LIMIT),
    totalOutcomes: z.number().int().nonnegative().max(250),
    hasNextPage: z.boolean(),
    nextCursor: z
      .string()
      .max(PRODUCT_FEED_ROW_PREVIEW_MAX_CURSOR_LENGTH)
      .nullable(),
    responseTruncated: z.boolean(),
  }),
  semantics: z.object({
    basis: z.literal("current_saved_state"),
    emittedRowsAreExact: z.literal(true),
    entryFieldsTruncated: z.literal(false),
    cachedFeedPropagationVerified: z.literal(false),
    providerAcceptanceVerified: z.literal(false),
    pagesMayRaceWithWrites: z.literal(true),
    responseBudgetBytes: z.literal(
      PRODUCT_FEED_ROW_PREVIEW_RESPONSE_BUDGET_BYTES,
    ),
  }),
});

const route = createRoute({
  method: "get",
  path: "/seo/feed-row-preview/{productId}",
  tags: ["Admin - Settings"],
  summary: "Preview exact emitted catalog feed rows for one product",
  description:
    "Projects current saved product state through the same Google/Meta row authority. It does not prove cache propagation or provider acceptance.",
  operationId: "dashboard.seo.feed_row_preview",
  request: {
    params: z.object({
      productId: z
        .string()
        .trim()
        .min(1)
        .max(PRODUCT_FEED_ROW_PREVIEW_MAX_PRODUCT_ID_LENGTH),
    }),
    query: z.object({
      sku: z
        .string()
        .trim()
        .min(1)
        .max(PRODUCT_FEED_ROW_PREVIEW_MAX_SKU_LENGTH)
        .optional(),
      cursor: z
        .string()
        .min(1)
        .max(PRODUCT_FEED_ROW_PREVIEW_MAX_CURSOR_LENGTH)
        .optional(),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(PRODUCT_FEED_ROW_PREVIEW_MAX_LIMIT)
        .optional(),
    }),
  },
  responses: {
    200: {
      description:
        "Bounded current-state emitted, omitted, or oversize outcomes in stable candidate order",
      content: {
        "application/json": {
          schema: successEnvelope(productFeedRowPreviewResponseSchema),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(
  route,
  (async (c) => {
    c.header("Cache-Control", "private, no-store");
    const db = c.get("db");
    const { productId } = c.req.valid("param");
    const query = c.req.valid("query");
    validateProductFeedRowPreviewCursor(query.cursor);

    // Read settings sequentially. Feed-disabled is authoritative and lets the
    // core executor stop before any product/enrichment query.
    const seo = await getSeoSettings(db);
    const currency = seo.discovery.feeds.productCatalogEnabled
      ? await getCurrencySettings(db)
      : { currencyCode: "BDT" };
    const media = seo.discovery.feeds.productCatalogEnabled
      ? await getMediaOptimizationSettings(db)
      : {
          enabled: true,
          canonicalCdnUrl: "",
          allowedImageHosts: [],
          canonicalHostAliases: [],
        };

    const result = await executeProductFeedRowPreview({
      db,
      productId,
      sku: query.sku,
      cursor: query.cursor,
      limit: query.limit,
      storefrontBaseUrl: c.env.STOREFRONT_URL,
      currencyCode: currency.currencyCode,
      feedsPolicy: seo.discovery.feeds,
      mediaPolicy: media,
      environmentCdnUrl: c.env.CDN_DOMAIN_URL,
    });
    return ok(c, result);
  }) as AppRouteHandler<typeof route>,
);

export { app as feedRowPreviewRoutes };
