// Product writes in the stable app API (operation-registry/README.md) for
// PIM and ERP sync, mounted at /admin/resources: the product editor's own
// create and base-section writes (product-admin), in integer minor units of
// the store currency, answering with the sealed ProductResource.
//
// Stock is not set here (`write_products` never changes stock): new SKUs start
// at 0 on hand, and quantities move through the inventory ledger
// (`dashboard.resources.variants.bulk_set_stock`, `write_inventory`). SKUs
// change one at a time (`variants.create`, `variants.update`,
// `variants.restore`, below) or many prices at once
// (`dashboard.resources.variants.bulk_set_prices`).
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { nanoid } from "nanoid";
import { EVENT_REPRESENTATION_SCHEMAS } from "@scalius/shared/events";
import { PRODUCT_CONDITION_VALUES } from "@scalius/shared/product-condition";
import { MAX_PRODUCT_OPTION_AXES, MAX_PRODUCT_OPTION_COMBINATIONS } from "@scalius/shared/product-options";
import { fromMinor } from "@scalius/shared/money";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { addProductSku, createProduct, createProductSchema, restoreProductSku, updateProductResourceSections, updateProductSku } from "@scalius/core/modules/product-admin";
import type { Context } from "hono";
import { MAX_PRODUCT_MEDIA_ASSOCIATIONS } from "@scalius/core/modules/products";
import { readStoreCurrency } from "@scalius/core/modules/markets";
import { created, ok } from "../../utils/api-response";
import { NotFoundError, ValidationError } from "../../utils/api-error";
import { conflictResponse, errorResponses, namedSharedSchema, successEnvelope } from "../../schemas/responses";
import { readProductRepresentations } from "../../events/representations";
import { refreshRecommendationsAfterWrite } from "../../background/catalog";
import { products } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { and, inArray, isNull } from "drizzle-orm";
import { planLimits } from "@scalius/shared/plan-limits";
import { idempotencyKeyHeaderSchema } from "./idempotency";
import { registerAppContentRoutes } from "./resources-app-content";
import { batchItemKeySchema, batchRequestSchema, batchResultSchema, runBatchCreate, type BatchCreateData, type BatchRef } from "./resources-batch";

const app = new OpenAPIHono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
});

const ProductResource = namedSharedSchema(EVENT_REPRESENTATION_SCHEMAS.product, "ProductResource");
const productEnvelope = successEnvelope(z.object({ product: ProductResource }));
const writeResponses = { ...errorResponses, 409: conflictResponse };

const priceMinor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const barcodeTypes = ["ean13", "upc", "isbn", "gtin", "code128", "custom"] as const;
const slug = z.string().min(3).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const idParamSchema = z.object({ id: z.string().min(1).max(128) });

const variantInput = z.object({
  sku: z.string().trim().min(3).max(100).openapi({ description: "Unique in the store, any case." }),
  priceMinor: priceMinor.openapi({ description: "Its price, in minor units of the store currency at its price increment." }),
  optionValues: z.record(z.string().trim().min(1).max(40), z.string().trim().min(1).max(100)).optional()
    .openapi({ description: "One value of every option, by option name (`{ \"Size\": \"M\", \"Color\": \"Red\" }`); leave it out on a product without options." }),
  barcode: z.string().trim().min(1).max(50).nullable().optional().openapi({ description: "Omit or null to generate an internal barcode." }),
  barcodeType: z.enum(barcodeTypes).nullable().optional().openapi({ description: "Required with `barcode`." }),
  trackInventory: z.boolean().default(true).openapi({ description: "Count its stock. It starts at 0: set quantities through inventory." }),
  weightGrams: z.number().min(0).max(1_000_000).nullable().optional(),
}).strict();

const optionInput = z.object({
  name: z.string().trim().min(1).max(40),
  values: z.array(z.string().trim().min(1).max(100)).min(1).max(MAX_PRODUCT_OPTION_COMBINATIONS),
  standardMapping: z.enum(["size", "color", "material", "pattern", "none"]).default("none")
    .openapi({ description: "Which standard attribute it is for catalog feeds; each one at most once." }),
}).strict();

const createBody = z.object({
  name: z.string().trim().min(3).max(100),
  description: z.string().min(10).nullable().optional(),
  slug: slug.optional().openapi({ description: "Omit to derive the web address from the name; a taken one gets a -2, -3… suffix." }),
  status: z.enum(["active", "draft"]).default("draft").openapi({ description: "An active product needs a price above 0 on every SKU." }),
  condition: z.enum(PRODUCT_CONDITION_VALUES),
  categoryId: z.string().min(1).max(180).nullable().optional(),
  brandId: z.string().min(1).max(128).nullable().optional(),
  metaTitle: z.string().max(200).nullable().optional(),
  metaDescription: z.string().max(500).nullable().optional(),
  options: z.array(optionInput).max(MAX_PRODUCT_OPTION_AXES).default([])
    .openapi({ description: "Merchant-named options (up to five). Leave empty for a product sold as one SKU." }),
  variants: z.array(variantInput).min(1).max(MAX_PRODUCT_OPTION_COMBINATIONS)
    .openapi({ description: "With options, one SKU per combination, each using every option's value; without options, exactly one." }),
  mediaIds: z.array(z.string().trim().min(8).max(160)).max(50).default([])
    .openapi({ description: "Ready media library files (`dashboard.media.import_url`), in gallery order; the first is featured." }),
  salesChannelIds: z.array(z.string().min(1).max(160)).max(50).optional()
    .openapi({ description: "The sales channels to publish it to. Omit to publish it to every channel." }),
}).strict();

type CreateBody = z.infer<typeof createBody>;

/** The editor's create input for a resource-shaped body: draft ids, major units at the edge, stock 0. */
function editorCreateInput(body: CreateBody, places: number): unknown {
  const major = (minor: number) => fromMinor(minor, places);
  const barcode = (variant: CreateBody["variants"][number]) => ({
    barcode: variant.barcode ?? null,
    barcodeType: variant.barcode ? variant.barcodeType ?? null : null,
  });
  const base = {
    name: body.name,
    description: body.description ?? null,
    ...(body.slug ? { slug: body.slug } : {}),
    isActive: body.status === "active",
    productCondition: body.condition,
    categoryId: body.categoryId ?? null,
    ...(body.brandId !== undefined ? { brandId: body.brandId } : {}),
    freeDelivery: false,
    metaTitle: body.metaTitle ?? null,
    metaDescription: body.metaDescription ?? null,
    canonicalPath: null,
    media: body.mediaIds.map((mediaId, index) => ({ id: `pmed_${nanoid()}`, mediaId, altText: null, isPrimary: index === 0 })),
    attributes: [],
    ...(body.salesChannelIds ? { salesChannelIds: body.salesChannelIds } : {}),
  };
  if (body.options.length === 0) {
    if (body.variants.length !== 1 || body.variants[0]!.optionValues) {
      throw new ValidationError("A product without options has exactly one SKU and no optionValues.", { field: "variants" });
    }
    const variant = body.variants[0]!;
    return {
      ...base,
      price: major(variant.priceMinor),
      defaultSku: { sku: variant.sku, trackInventory: variant.trackInventory, stock: 0, ...barcode(variant), weight: variant.weightGrams ?? null },
    };
  }
  const options = body.options.map((option, optionIndex) => ({
    id: `draft_opt_${optionIndex}`,
    name: option.name,
    standardMapping: option.standardMapping,
    values: option.values.map((value, valueIndex) => ({ id: `draft_val_${optionIndex}_${valueIndex}`, value })),
  }));
  const variants = body.variants.map((variant, variantIndex) => {
    const chosen = new Map(Object.entries(variant.optionValues ?? {}).map(([name, value]) => [name.toLocaleLowerCase("en-US"), value]));
    const selectedOptionValueIds = options.map((option) => {
      const wanted = chosen.get(option.name.toLocaleLowerCase("en-US"));
      const value = option.values.find((candidate) => candidate.value === wanted);
      if (!value) {
        throw new ValidationError(`variants.${variantIndex}: choose one of the ${option.name} values.`, { field: `variants.${variantIndex}.optionValues` });
      }
      return value.id;
    });
    if (chosen.size !== options.length) {
      throw new ValidationError(`variants.${variantIndex}: name one value for each option and no other.`, { field: `variants.${variantIndex}.optionValues` });
    }
    return {
      id: `draft_var_${variantIndex}`,
      selectedOptionValueIds,
      imageId: null,
      sku: variant.sku,
      price: major(variant.priceMinor),
      stock: 0,
      trackInventory: variant.trackInventory,
      weight: variant.weightGrams ?? null,
      ...barcode(variant),
      discountType: "percentage",
      discountPercentage: null,
      discountAmount: null,
    };
  });
  return {
    ...base,
    price: Math.min(...variants.map((variant) => variant.price)),
    optionMatrix: { options, variants },
  };
}

function issuesError(error: z.ZodError): ValidationError {
  return new ValidationError(error.issues[0]?.message ?? "Check the product.", {
    issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  });
}

/** Whether the database refused the write because a row it names does not exist (any wrapper level). */
function isForeignKeyRefusal(error: unknown, depth = 0): boolean {
  if (typeof error !== "object" || error === null || depth > 4) return false;
  const { message, cause } = error as { message?: unknown; cause?: unknown };
  return (typeof message === "string" && /FOREIGN KEY constraint failed/i.test(message)) || isForeignKeyRefusal(cause, depth + 1);
}

/**
 * The editor's create for a resource-shaped body: the one path of the single
 * and the batch create. A category, brand, media file or sales channel that
 * does not exist is a refusal of the input (the product write is one atomic
 * batch, so nothing is left behind), not a server fault.
 */
async function createProductFromBody(db: Database, body: CreateBody, places: number, id?: string): Promise<string> {
  const parsed = createProductSchema.safeParse(editorCreateInput(body, places));
  if (!parsed.success) throw issuesError(parsed.error);
  try {
    return (await createProduct(db, parsed.data, id ? { id } : {})).id;
  } catch (error) {
    if (isForeignKeyRefusal(error)) {
      throw new ValidationError("A category, brand, media file or sales channel named in the product does not exist.", {
        fields: ["categoryId", "brandId", "mediaIds", "salesChannelIds"],
      });
    }
    throw error;
  }
}

app.openapi(createRoute({
  operationId: "dashboard.resources.products.create",
  method: "post",
  path: "/products",
  tags: ["App API - Products"],
  summary: "Create a product with its options and SKUs",
  description: "Creates a product the way the editor does, prices in minor units of the store currency. Its SKUs start with 0 on hand: set stock through inventory (`dashboard.resources.variants.bulk_set_stock`). Send an Idempotency-Key: a repeat returns the first product.",
  request: {
    headers: idempotencyKeyHeaderSchema,
    body: { required: true, content: { "application/json": { schema: createBody } } },
  },
  responses: {
    201: { description: "The product", content: { "application/json": { schema: productEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");
  const places = getDecimalPlaces((await readStoreCurrency(db)).code);
  const id = await createProductFromBody(db, body, places);
  await refreshRecommendationsAfterWrite(c, db, [id]);
  const [product] = await readProductRepresentations(db, [id]);
  if (!product) throw new NotFoundError("Product not found");
  return created(c, { product });
});

// Batch create (resources-batch.ts): many products per call, each item the
// create body above plus its `key`, replayed per item (its id derives from the key).
//
// Bound (plan value `batchCreates.products`: Free 4, Paid 20), measured in
// resources-batch.d1.test.ts: a call costs 6 D1 calls and each product 4
// (the id check, slug, SKU check, the write batch), plus 2 for
// its recommendation refresh after the response (the first 5 products of a
// call) and 3 more when it names a category and a brand. Four such products
// are about 36 D1 calls; with the ~6 of the idempotency middleware and plugin
// dispatch that is about 42 of Free's 50 per invocation. Paid allows 1,000.
const batchItem = createBody.extend({ key: batchItemKeySchema });
const batchBody = batchRequestSchema(batchItem, planLimits("paid").batchCreates.products);
const batchResult = successEnvelope(batchResultSchema("product"));

async function readProductRefs(db: Database, ids: readonly string[]): Promise<Map<string, BatchRef>> {
  const rows = await db
    .select({ id: products.id, slug: products.slug, revision: products.aggregateRevision })
    .from(products)
    .where(and(inArray(products.id, [...ids]), isNull(products.deletedAt)));
  return new Map(rows.map((row) => [row.id, row]));
}

app.openapi(createRoute({
  operationId: "dashboard.resources.products.batch_create",
  method: "post",
  path: "/products/batch",
  tags: ["App API - Products"],
  summary: "Create many products in one call",
  description: "Creates up to the plan's bound of products (20 on Paid, fewer on Free), each the body of `products.create` plus a `key` of yours. Items run in order and one refusal never stops the others: each result is `created`, `replayed` (that key already created its product earlier; nothing is created again) or `failed` with the refusal's code. Results carry `{ id, slug, revision }`; read a full product with `products.get`. Send an Idempotency-Key too: a repeat of the whole request returns the first response.",
  request: {
    headers: idempotencyKeyHeaderSchema,
    body: { required: true, content: { "application/json": { schema: batchBody } } },
  },
  responses: {
    200: { description: "One result per item, in request order", content: { "application/json": { schema: batchResult } } },
    ...writeResponses,
  },
}), async (c) => {
  const db = c.get("db");
  const { items } = c.req.valid("json");
  const places = getDecimalPlaces((await readStoreCurrency(db)).code);
  const { data, createdIds } = await runBatchCreate(c, {
    operationId: "dashboard.resources.products.batch_create",
    noun: "product",
    plural: "products",
    items,
    bound: planLimits().batchCreates.products,
    idPrefix: "prod_",
    create: ({ key: _key, ...body }, id) => createProductFromBody(db, body, places, id),
    existing: async (ids) => new Set((await db.select({ id: products.id }).from(products).where(inArray(products.id, [...ids]))).map((row) => row.id)),
    readRefs: (ids) => readProductRefs(db, ids),
  });
  await refreshRecommendationsAfterWrite(c, db, createdIds);
  return ok(c, data as BatchCreateData<"product">);
});

const updateBody = z.object({
  expectedRevision: z.number().int().positive().openapi({ description: "The product's `revision` you read; a product changed since is refused with 409 and nothing is saved." }),
  name: z.string().trim().min(3).max(100).optional(),
  description: z.string().min(10).nullable().optional(),
  slug: slug.optional(),
  status: z.enum(["active", "draft"]).optional().openapi({ description: "An active product needs a price above 0." }),
  condition: z.enum(PRODUCT_CONDITION_VALUES).nullable().optional(),
  categoryId: z.string().min(1).max(180).nullable().optional(),
  brandId: z.string().min(1).max(128).nullable().optional(),
  metaTitle: z.string().max(200).nullable().optional(),
  metaDescription: z.string().max(500).nullable().optional(),
  priceMinor: priceMinor.optional().openapi({ description: "A product without options: its price, in minor units of the store currency. A product with options prices each SKU (`variants.bulk_set_prices`, `variants.update`)." }),
  mediaIds: z.array(z.string().trim().min(8).max(160)).max(MAX_PRODUCT_MEDIA_ASSOCIATIONS).optional()
    .openapi({ description: "The whole gallery: ready media library files in order, the first featured; [] removes them all. Files it already shows keep their alt text; a SKU that showed a removed image shows the featured one." }),
  salesChannelIds: z.array(z.string().min(1).max(160)).max(50).optional()
    .openapi({ description: "Exactly the sales channels to publish it to (as `products.set_publications`); [] unpublishes it everywhere." }),
}).strict().refine((value) => Object.keys(value).length > 1, "Send at least one field to change.");

app.openapi(createRoute({
  operationId: "dashboard.resources.products.update",
  method: "patch",
  path: "/products/{id}",
  tags: ["App API - Products"],
  summary: "Change a product's fields under the revision you read",
  description: "Patch semantics: fields left out keep their value, null clears. Base fields, the gallery (`mediaIds`) and the sales channels change in one write that advances the revision once. SKUs change with `variants.create`, `variants.update`, `variants.retire` and `variants.restore`; stock never changes here.",
  request: {
    params: z.object({ id: z.string().min(1).max(128) }),
    headers: idempotencyKeyHeaderSchema,
    body: { required: true, content: { "application/json": { schema: updateBody } } },
  },
  responses: {
    200: { description: "The product", content: { "application/json": { schema: productEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  if (body.priceMinor !== undefined) {
    const [existing] = await readProductRepresentations(db, [id]);
    if (!existing) throw new NotFoundError("Product not found");
    if (existing.variants.some((variant) => !variant.isDefault)) {
      throw new ValidationError("This product prices each SKU: use dashboard.resources.variants.bulk_set_prices.", { field: "priceMinor" });
    }
  }
  const places = getDecimalPlaces((await readStoreCurrency(db)).code);
  const patch = {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.description !== undefined ? { description: body.description } : {}),
    ...(body.slug !== undefined ? { slug: body.slug, canonicalPath: null } : {}),
    ...(body.status !== undefined ? { isActive: body.status === "active" } : {}),
    ...(body.condition !== undefined ? { productCondition: body.condition } : {}),
    ...(body.categoryId !== undefined ? { categoryId: body.categoryId } : {}),
    ...(body.brandId !== undefined ? { brandId: body.brandId } : {}),
    ...(body.metaTitle !== undefined ? { metaTitle: body.metaTitle } : {}),
    ...(body.metaDescription !== undefined ? { metaDescription: body.metaDescription } : {}),
    ...(body.priceMinor !== undefined ? { price: fromMinor(body.priceMinor, places) } : {}),
  };
  const result = await updateProductResourceSections(db, id, body.expectedRevision, {
    base: patch,
    ...(body.mediaIds ? { mediaIds: body.mediaIds } : {}),
    ...(body.salesChannelIds ? { salesChannelIds: body.salesChannelIds } : {}),
  });
  if (!result) throw new NotFoundError("Product not found");
  await refreshRecommendationsAfterWrite(c, db, [id]);
  const [product] = await readProductRepresentations(db, [id]);
  if (!product) throw new NotFoundError("Product not found");
  return ok(c, { product });
});

// ─── SKUs ────────────────────────────────────────────────────────────────────
// One SKU at a time under the product's revision (product-admin sku-writes.ts):
// options by name and value, prices in minor units, stock never changed.
// Each write answers the product, whose `revision` the next write sends.

const optionValuesInput = z.record(z.string().trim().min(1).max(40), z.string().trim().min(1).max(100))
  .openapi({ description: "One value of every option, by option name (`{ \"Size\": \"XL\", \"Color\": \"Red\" }`), any case. A value the option does not have yet is added to it." });
const productRevision = z.number().int().positive()
  .openapi({ description: "The product's `revision` you read; a product changed since is refused with 409 and nothing is saved." });
const variantParams = z.object({ id: z.string().min(1).max(128), variantId: z.string().min(1).max(128) });
const skuMediaId = z.string().trim().min(8).max(160).nullable().optional();

const createVariantBody = z.object({
  expectedRevision: productRevision,
  sku: variantInput.shape.sku,
  priceMinor: variantInput.shape.priceMinor,
  optionValues: optionValuesInput,
  barcode: variantInput.shape.barcode,
  barcodeType: variantInput.shape.barcodeType,
  trackInventory: variantInput.shape.trackInventory,
  weightGrams: variantInput.shape.weightGrams,
  mediaId: skuMediaId.openapi({ description: "Its own image: a file in the product's gallery. Omit or null to show the featured image." }),
}).strict();

app.openapi(createRoute({
  operationId: "dashboard.resources.variants.create",
  method: "post",
  path: "/products/{id}/variants",
  tags: ["App API - Products"],
  summary: "Add a SKU to a product with options",
  description: "Adds one SKU for a new combination of the product's options, named by value; a value an option lacks is added to it. A combination a retired SKU had brings that SKU back (its stock and history) under this code and price; otherwise it starts with 0 on hand (set stock through inventory). A product sold as one SKU takes no other. Answers the product with its new revision.",
  request: {
    params: idParamSchema,
    headers: idempotencyKeyHeaderSchema,
    body: { required: true, content: { "application/json": { schema: createVariantBody } } },
  },
  responses: {
    201: { description: "The product with the new SKU", content: { "application/json": { schema: productEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const { expectedRevision, ...input } = c.req.valid("json");
  await addProductSku(db, id, expectedRevision, input);
  return created(c, { product: await readProductAfterWrite(c, db, id) });
});

const updateVariantBody = z.object({
  expectedRevision: productRevision,
  sku: variantInput.shape.sku.optional(),
  priceMinor: priceMinor.optional().openapi({ description: "Its price, in minor units of the store currency. On a product sold as one SKU this is the product's price." }),
  optionValues: optionValuesInput.optional(),
  barcode: z.string().trim().min(1).max(50).nullable().optional().openapi({ description: "Null clears it." }),
  barcodeType: z.enum(barcodeTypes).optional().openapi({ description: "Omit to keep the current type." }),
  trackInventory: z.boolean().optional(),
  weightGrams: variantInput.shape.weightGrams,
  mediaId: skuMediaId.openapi({ description: "Its own image, a file in the product's gallery; null shows the featured image." }),
}).strict().refine((value) => Object.keys(value).length > 1, "Send at least one field to change.");

app.openapi(createRoute({
  operationId: "dashboard.resources.variants.update",
  method: "patch",
  path: "/products/{id}/variants/{variantId}",
  tags: ["App API - Products"],
  summary: "Change a SKU under the product's revision",
  description: "Patch semantics: fields left out keep their value. Changes a live SKU's code, price, barcode, weight, tracking, image or option values (another combination; a value an option lacks is added). SKU codes and barcodes are unique in the store, any case. Stock never changes here. Answers the product with its new revision.",
  request: {
    params: variantParams,
    headers: idempotencyKeyHeaderSchema,
    body: { required: true, content: { "application/json": { schema: updateVariantBody } } },
  },
  responses: {
    200: { description: "The product", content: { "application/json": { schema: productEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  const db = c.get("db");
  const { id, variantId } = c.req.valid("param");
  const { expectedRevision, ...input } = c.req.valid("json");
  await updateProductSku(db, id, variantId, expectedRevision, input);
  return ok(c, { product: await readProductAfterWrite(c, db, id) });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.variants.restore",
  method: "post",
  path: "/products/{id}/variants/{variantId}/restore",
  tags: ["App API - Products"],
  summary: "Bring a retired SKU back",
  description: "The inverse of `variants.retire`: the same SKU (id, code, barcode, stock and history) sells again under its old combination. Refused when the product's options no longer have that combination's options, or a live SKU already sells it. Answers the product with its new revision.",
  request: {
    params: variantParams,
    headers: idempotencyKeyHeaderSchema,
    body: { required: true, content: { "application/json": { schema: z.object({ expectedRevision: productRevision }).strict() } } },
  },
  responses: {
    200: { description: "The product with the SKU back", content: { "application/json": { schema: productEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  const db = c.get("db");
  const { id, variantId } = c.req.valid("param");
  await restoreProductSku(db, id, variantId, c.req.valid("json").expectedRevision);
  return ok(c, { product: await readProductAfterWrite(c, db, id) });
});

/** The product as a write left it, its recommendations refresh queued. */
async function readProductAfterWrite(c: Context<{ Bindings: Env }>, db: Database, id: string) {
  await refreshRecommendationsAfterWrite(c, db, [id]);
  const [product] = await readProductRepresentations(db, [id]);
  if (!product) throw new NotFoundError("Product not found");
  return product;
}

registerAppContentRoutes(app);

export { app as adminResourceProductRoutes };
