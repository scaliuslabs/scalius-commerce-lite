import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  calculateTaxQuote,
  createTaxClass,
  createTaxRate,
  deleteTaxClass,
  deleteTaxRate,
  fromMinorUnits,
  getTaxConfiguration,
  listTaxClassifications,
  toMinorUnits,
  updateTaxClass,
  updateTaxClassification,
  updateTaxRate,
  updateTaxSettings,
  type TaxJurisdictionType,
} from "@scalius/core/modules/tax";
import { getCurrencyConfig } from "@scalius/core/modules/settings";
import { resolveActiveDeliveryLocationNames } from "@scalius/core/modules/orders/delivery-location-validation";
import { created, ok } from "../../utils/api-response";
import {
  conflictResponse,
  errorResponses,
  successEnvelope,
} from "../../schemas/responses";
import { invalidateApiAndScheduleStorefrontGroups } from "../../utils/cache-invalidation";

const app = new OpenAPIHono<{ Bindings: Env }>();
const TAX_CACHE_GROUPS = ["checkout"] as const;

function serializeTimestamp(value: unknown): string | number | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function serializeTaxClass(row: Awaited<ReturnType<typeof createTaxClass>>) {
  return {
    ...row,
    createdAt: serializeTimestamp(row.createdAt),
    updatedAt: serializeTimestamp(row.updatedAt),
    deletedAt: serializeTimestamp(row.deletedAt),
  };
}

function serializeTaxRate(row: Awaited<ReturnType<typeof createTaxRate>>) {
  return {
    ...row,
    createdAt: serializeTimestamp(row.createdAt),
    updatedAt: serializeTimestamp(row.updatedAt),
    deletedAt: serializeTimestamp(row.deletedAt),
  };
}

function serializeTaxSettings(row: Awaited<ReturnType<typeof updateTaxSettings>>) {
  return {
    ...row,
    id: "default" as const,
    createdAt: serializeTimestamp(row.createdAt),
    updatedAt: serializeTimestamp(row.updatedAt),
  };
}

const nullableTimestampSchema = z.union([z.string(), z.number()]).nullable();
const taxClassSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isExempt: z.boolean(),
  version: z.number().int(),
  createdAt: nullableTimestampSchema,
  updatedAt: nullableTimestampSchema,
  deletedAt: nullableTimestampSchema,
});
const jurisdictionTypeSchema = z.enum(["all", "city", "zone", "area"]);
const taxRateSchema = z.object({
  id: z.string(),
  taxClassId: z.string(),
  name: z.string(),
  rateBps: z.number().int(),
  jurisdictionType: jurisdictionTypeSchema,
  jurisdictionId: z.string().nullable(),
  jurisdictionLabel: z.string().nullable(),
  priority: z.number().int(),
  isCompound: z.boolean(),
  isActive: z.boolean(),
  version: z.number().int(),
  createdAt: nullableTimestampSchema,
  updatedAt: nullableTimestampSchema,
  deletedAt: nullableTimestampSchema,
});
const taxSettingsSchema = z.object({
  id: z.literal("default"),
  enabled: z.boolean(),
  pricesIncludeTax: z.boolean(),
  taxShipping: z.boolean(),
  defaultTaxClassId: z.string().nullable(),
  shippingTaxClassId: z.string().nullable(),
  displayLabel: z.string(),
  version: z.number().int(),
  createdAt: nullableTimestampSchema,
  updatedAt: nullableTimestampSchema,
});
const taxConfigurationSchema = z.object({
  settings: taxSettingsSchema,
  classes: z.array(taxClassSchema),
  rates: z.array(taxRateSchema),
  jurisdictions: z.array(z.object({
    id: z.string(),
    name: z.string(),
    type: z.enum(["city", "zone", "area"]),
    parentId: z.string().nullable(),
  })),
});

const getConfigurationRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin - Taxes"],
  summary: "Get tax settings, classes, and rates",
  responses: {
    200: { description: "Tax configuration", content: { "application/json": { schema: successEnvelope(taxConfigurationSchema) } } },
    ...errorResponses,
  },
});

app.openapi(getConfigurationRoute, async (c) => {
  const configuration = await getTaxConfiguration(c.get("db"));
  const settings = {
    ...configuration.settings,
    id: "default" as const,
    createdAt: serializeTimestamp(configuration.settings.createdAt),
    updatedAt: serializeTimestamp(configuration.settings.updatedAt),
  };
  return ok(c, {
    ...configuration,
    settings,
    classes: configuration.classes.map(serializeTaxClass),
    rates: configuration.rates.map(serializeTaxRate),
  });
});

const updateSettingsBodySchema = z.object({
  expectedVersion: z.number().int().min(0),
  enabled: z.boolean(),
  pricesIncludeTax: z.boolean(),
  taxShipping: z.boolean(),
  defaultTaxClassId: z.string().max(180).nullable(),
  shippingTaxClassId: z.string().max(180).nullable(),
  displayLabel: z.string().trim().min(1).max(80),
}).strict();

const updateSettingsRoute = createRoute({
  method: "put",
  path: "/settings",
  tags: ["Admin - Taxes"],
  summary: "Update versioned tax settings",
  request: { body: { required: true, content: { "application/json": { schema: updateSettingsBodySchema } } } },
  responses: {
    200: { description: "Tax settings updated", content: { "application/json": { schema: successEnvelope(z.object({ settings: taxSettingsSchema })) } } },
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    409: conflictResponse,
  },
});

app.openapi(updateSettingsRoute, async (c) => {
  const settings = await updateTaxSettings(c.get("db"), c.req.valid("json"));
  await invalidateApiAndScheduleStorefrontGroups(TAX_CACHE_GROUPS, c);
  return ok(c, { settings: serializeTaxSettings(settings) });
});

const createClassBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional().nullable(),
  isExempt: z.boolean().optional().default(false),
}).strict();
const updateClassBodySchema = z.object({
  expectedVersion: z.number().int().min(1),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional().nullable(),
  isExempt: z.boolean().optional(),
}).strict();

const createClassRoute = createRoute({
  method: "post",
  path: "/classes",
  tags: ["Admin - Taxes"],
  summary: "Create a tax class",
  request: { body: { required: true, content: { "application/json": { schema: createClassBodySchema } } } },
  responses: {
    201: { description: "Tax class created", content: { "application/json": { schema: successEnvelope(z.object({ taxClass: taxClassSchema })) } } },
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    409: conflictResponse,
  },
});
app.openapi(createClassRoute, async (c) => {
  const taxClass = await createTaxClass(c.get("db"), c.req.valid("json"));
  await invalidateApiAndScheduleStorefrontGroups(TAX_CACHE_GROUPS, c);
  return created(c, { taxClass: serializeTaxClass(taxClass) });
});

const updateClassRoute = createRoute({
  method: "put",
  path: "/classes/{id}",
  tags: ["Admin - Taxes"],
  summary: "Update a versioned tax class",
  request: {
    params: z.object({ id: z.string().min(1).max(180) }),
    body: { required: true, content: { "application/json": { schema: updateClassBodySchema } } },
  },
  responses: {
    200: { description: "Tax class updated", content: { "application/json": { schema: successEnvelope(z.object({ taxClass: taxClassSchema })) } } },
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: conflictResponse,
  },
});
app.openapi(updateClassRoute, async (c) => {
  const taxClass = await updateTaxClass(c.get("db"), c.req.valid("param").id, c.req.valid("json"));
  await invalidateApiAndScheduleStorefrontGroups(TAX_CACHE_GROUPS, c);
  return ok(c, { taxClass: serializeTaxClass(taxClass) });
});

const versionQuerySchema = z.object({ expectedVersion: z.coerce.number().int().min(1) });
const deleteClassRoute = createRoute({
  method: "delete",
  path: "/classes/{id}",
  tags: ["Admin - Taxes"],
  summary: "Soft-delete an unused tax class",
  request: {
    params: z.object({ id: z.string().min(1).max(180) }),
    query: versionQuerySchema,
  },
  responses: {
    200: { description: "Tax class deleted", content: { "application/json": { schema: successEnvelope(z.object({ taxClass: taxClassSchema })) } } },
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: conflictResponse,
  },
});
app.openapi(deleteClassRoute, async (c) => {
  const taxClass = await deleteTaxClass(c.get("db"), c.req.valid("param").id, c.req.valid("query").expectedVersion);
  await invalidateApiAndScheduleStorefrontGroups(TAX_CACHE_GROUPS, c);
  return ok(c, { taxClass: serializeTaxClass(taxClass) });
});

const rateBodySchema = z.object({
  taxClassId: z.string().min(1).max(180),
  name: z.string().trim().min(1).max(120),
  rateBps: z.number().int().min(0).max(10_000),
  jurisdictionType: jurisdictionTypeSchema,
  jurisdictionId: z.string().trim().max(180).optional().nullable(),
  jurisdictionLabel: z.string().trim().max(180).optional().nullable(),
  priority: z.number().int().min(0).max(1_000).optional().default(0),
  isCompound: z.boolean().optional().default(false),
  isActive: z.boolean().optional().default(true),
}).strict();
const updateRateBodySchema = z.object({
  expectedVersion: z.number().int().min(1),
  taxClassId: z.string().min(1).max(180).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  rateBps: z.number().int().min(0).max(10_000).optional(),
  jurisdictionType: jurisdictionTypeSchema.optional(),
  jurisdictionId: z.string().trim().max(180).optional().nullable(),
  jurisdictionLabel: z.string().trim().max(180).optional().nullable(),
  priority: z.number().int().min(0).max(1_000).optional(),
  isCompound: z.boolean().optional(),
  isActive: z.boolean().optional(),
}).strict();

const createRateRoute = createRoute({
  method: "post",
  path: "/rates",
  tags: ["Admin - Taxes"],
  summary: "Create a merchant-configured tax rate",
  request: { body: { required: true, content: { "application/json": { schema: rateBodySchema } } } },
  responses: {
    201: { description: "Tax rate created", content: { "application/json": { schema: successEnvelope(z.object({ taxRate: taxRateSchema })) } } },
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    409: conflictResponse,
  },
});
app.openapi(createRateRoute, async (c) => {
  const taxRate = await createTaxRate(c.get("db"), c.req.valid("json"));
  await invalidateApiAndScheduleStorefrontGroups(TAX_CACHE_GROUPS, c);
  return created(c, { taxRate: serializeTaxRate(taxRate) });
});

const updateRateRoute = createRoute({
  method: "put",
  path: "/rates/{id}",
  tags: ["Admin - Taxes"],
  summary: "Update a versioned tax rate",
  request: {
    params: z.object({ id: z.string().min(1).max(180) }),
    body: { required: true, content: { "application/json": { schema: updateRateBodySchema } } },
  },
  responses: {
    200: { description: "Tax rate updated", content: { "application/json": { schema: successEnvelope(z.object({ taxRate: taxRateSchema })) } } },
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: conflictResponse,
  },
});
app.openapi(updateRateRoute, async (c) => {
  const taxRate = await updateTaxRate(c.get("db"), c.req.valid("param").id, c.req.valid("json"));
  await invalidateApiAndScheduleStorefrontGroups(TAX_CACHE_GROUPS, c);
  return ok(c, { taxRate: serializeTaxRate(taxRate) });
});

const deleteRateRoute = createRoute({
  method: "delete",
  path: "/rates/{id}",
  tags: ["Admin - Taxes"],
  summary: "Soft-delete a tax rate",
  request: { params: z.object({ id: z.string().min(1).max(180) }), query: versionQuerySchema },
  responses: {
    200: { description: "Tax rate deleted", content: { "application/json": { schema: successEnvelope(z.object({ taxRate: taxRateSchema })) } } },
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: conflictResponse,
  },
});
app.openapi(deleteRateRoute, async (c) => {
  const taxRate = await deleteTaxRate(c.get("db"), c.req.valid("param").id, c.req.valid("query").expectedVersion);
  await invalidateApiAndScheduleStorefrontGroups(TAX_CACHE_GROUPS, c);
  return ok(c, { taxRate: serializeTaxRate(taxRate) });
});

const classificationItemSchema = z.object({
  kind: z.enum(["product", "variant"]),
  id: z.string(),
  productId: z.string(),
  productName: z.string(),
  label: z.string(),
  sku: z.string().nullable(),
  taxClassId: z.string().nullable(),
  taxClassName: z.string().nullable(),
  version: z.number().int(),
  aggregateRevision: z.number().int().min(1),
});
const listClassificationsRoute = createRoute({
  method: "get",
  path: "/classifications",
  tags: ["Admin - Taxes"],
  summary: "List product or SKU tax classifications",
  request: { query: z.object({
    kind: z.enum(["product", "variant"]).default("product"),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    search: z.string().trim().max(180).optional(),
  }) },
  responses: {
    200: { description: "Tax classifications", content: { "application/json": { schema: successEnvelope(z.object({
      items: z.array(classificationItemSchema),
      total: z.number().int(),
    })) } } },
    ...errorResponses,
  },
});
app.openapi(listClassificationsRoute, async (c) => ok(c, await listTaxClassifications(c.get("db"), c.req.valid("query"))));

const updateClassificationRoute = createRoute({
  method: "put",
  path: "/classifications/{kind}/{id}",
  tags: ["Admin - Taxes"],
  summary: "Update a versioned product or SKU tax classification",
  request: {
    params: z.object({ kind: z.enum(["product", "variant"]), id: z.string().min(1).max(180) }),
    body: { required: true, content: { "application/json": { schema: z.object({
      taxClassId: z.string().max(180).nullable(),
      expectedVersion: z.number().int().min(1),
      expectedAggregateRevision: z.number().int().min(1),
    }).strict() } } },
  },
  responses: {
    200: { description: "Tax classification updated", content: { "application/json": { schema: successEnvelope(z.object({
      classification: z.object({
        kind: z.enum(["product", "variant"]),
        id: z.string(),
        taxClassId: z.string().nullable(),
        version: z.number().int(),
        aggregateRevision: z.number().int().min(1),
      }),
    })) } } },
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    409: conflictResponse,
  },
});
app.openapi(updateClassificationRoute, async (c) => {
  const params = c.req.valid("param");
  const classification = await updateTaxClassification(c.get("db"), { ...params, ...c.req.valid("json") });
  await invalidateApiAndScheduleStorefrontGroups(TAX_CACHE_GROUPS, c);
  return ok(c, { classification });
});

const previewRoute = createRoute({
  method: "post",
  path: "/preview",
  tags: ["Admin - Taxes"],
  summary: "Preview current tax configuration server-side",
  request: { body: { required: true, content: { "application/json": { schema: z.object({
    amount: z.number().min(0).max(1_000_000_000),
    quantity: z.number().int().min(1).max(99).default(1),
    taxClassId: z.string().max(180).nullable().optional(),
    shippingAmount: z.number().min(0).max(1_000_000_000).default(0),
    discountAmount: z.number().min(0).max(1_000_000_000).default(0),
    city: z.string().min(1).max(180),
    zone: z.string().min(1).max(180),
    area: z.string().max(180).nullable().optional(),
  }).strict() } } } },
  responses: {
    200: { description: "Tax preview", content: { "application/json": { schema: successEnvelope(z.object({
      displayLabel: z.string(),
      pricesIncludeTax: z.boolean(),
      currencyCode: z.string(),
      decimalPlaces: z.number().int(),
      taxAmount: z.number(),
      taxMinor: z.number().int(),
      totalAmount: z.number(),
      totalMinor: z.number().int(),
      components: z.array(z.object({ name: z.string(), rateBps: z.number().int(), amountMinor: z.number().int() }).passthrough()),
    })) } } },
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
  },
});

app.openapi(previewRoute, async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");
  const [configuration, currency, locationNames] = await Promise.all([
    getTaxConfiguration(db),
    getCurrencyConfig(db),
    resolveActiveDeliveryLocationNames(db, {
      city: body.city,
      zone: body.zone,
      area: body.area,
    }),
  ]);
  const settings = configuration.settings;
  const quote = calculateTaxQuote({
    currencyCode: currency.code,
    decimalPlaces: currency.decimalPlaces,
    settings: {
      enabled: settings.enabled,
      pricesIncludeTax: settings.pricesIncludeTax,
      taxShipping: settings.taxShipping,
      defaultTaxClassId: settings.defaultTaxClassId,
      shippingTaxClassId: settings.shippingTaxClassId,
      displayLabel: settings.displayLabel,
      version: settings.version,
    },
    classes: configuration.classes.map((taxClass) => ({
      id: taxClass.id,
      name: taxClass.name,
      isExempt: taxClass.isExempt,
    })),
    rates: configuration.rates.map((rate) => ({
      id: rate.id,
      taxClassId: rate.taxClassId,
      name: rate.name,
      rateBps: rate.rateBps,
      jurisdictionType: rate.jurisdictionType as TaxJurisdictionType,
      jurisdictionId: rate.jurisdictionId,
      jurisdictionLabel: rate.jurisdictionLabel,
      priority: rate.priority,
      isCompound: rate.isCompound,
    })),
    destination: {
      city: body.city,
      zone: body.zone,
      area: body.area ?? null,
      cityName: locationNames.cityName,
      zoneName: locationNames.zoneName,
      areaName: locationNames.areaName,
    },
    lines: [{
      lineId: "preview",
      productId: "preview",
      variantId: "preview",
      unitPriceMinor: toMinorUnits(body.amount, currency.decimalPlaces),
      quantity: body.quantity,
      taxClassId: body.taxClassId ?? null,
    }],
    shippingMinor: toMinorUnits(body.shippingAmount, currency.decimalPlaces),
    discountMinor: toMinorUnits(body.discountAmount, currency.decimalPlaces),
  });
  return ok(c, {
    displayLabel: quote.displayLabel,
    pricesIncludeTax: quote.pricesIncludeTax,
    currencyCode: quote.currencyCode,
    decimalPlaces: quote.decimalPlaces,
    taxAmount: fromMinorUnits(quote.taxMinor, quote.decimalPlaces),
    taxMinor: quote.taxMinor,
    totalAmount: fromMinorUnits(quote.totalMinor, quote.decimalPlaces),
    totalMinor: quote.totalMinor,
    components: [
      ...quote.lines.flatMap((line) => line.components),
      ...quote.shipping.components,
    ],
  });
});

export { app as adminTaxRoutes };
