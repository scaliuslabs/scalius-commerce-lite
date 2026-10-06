import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { fromMinor, toMinor } from "@scalius/shared/money";
import {
  calculateStorefrontTaxQuote,
  createTaxClass,
  createTaxRate,
  createTaxRegion,
  deleteTaxClass,
  deleteTaxRate,
  deleteTaxRegion,
  getTaxConfiguration,
  getTaxRegion,
  getTaxSettingsDocument,
  listTaxClasses,
  listTaxJurisdictions,
  listTaxRates,
  listTaxRegions,
  updateTaxClass,
  updateTaxRate,
  updateTaxRegion,
  updateTaxSettings,
  type TaxRegionRecord,
} from "@scalius/core/modules/tax";
import { listTaxClassifications, updateTaxClassification } from "@scalius/core/modules/product-admin";
import { isQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import { resolveActiveDeliveryLocationNames } from "@scalius/core/modules/delivery";
import { readStoreCurrency } from "@scalius/core/modules/markets";
import type { Database } from "@scalius/database/client";
import { assertAppProviderInstalled, requestAppProviders } from "../../plugins/providers/app-providers";
import { created, ok } from "../../utils/api-response";
import {
  conflictResponse,
  errorResponses,
  successEnvelope,
} from "../../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();

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
  };
}

function serializeTaxRegion(region: TaxRegionRecord) {
  return {
    ...region,
    createdAt: serializeTimestamp(region.createdAt),
    updatedAt: serializeTimestamp(region.updatedAt),
  };
}

/** A tax provider choice must name an installed app's tax provider (`system` always exists). */
async function assertTaxProvider(db: Database, providerId: string | null | undefined): Promise<void> {
  if (providerId && isQualifiedProviderId(providerId)) await assertAppProviderInstalled(db, "tax", providerId);
}

function serializeTaxSettings(row: {
  enabled: boolean;
  taxShipping: boolean;
  defaultTaxClassId: string | null;
  shippingTaxClassId: string | null;
  displayLabel: string;
  providerId: string;
  version: number;
  createdAt: unknown;
  updatedAt: unknown;
}) {
  return {
    ...row,
    id: "default" as const,
    createdAt: serializeTimestamp(row.createdAt),
    updatedAt: serializeTimestamp(row.updatedAt),
  };
}

const nullableTimestampSchema = z.union([z.string(), z.number()]).nullable();
const taxClassSchema = z.object({
  id: z.string().max(180),
  name: z.string().max(120),
  description: z.string().max(500).nullable(),
  isExempt: z.boolean(),
  version: z.number().int(),
  createdAt: nullableTimestampSchema,
  updatedAt: nullableTimestampSchema,
  deletedAt: nullableTimestampSchema,
});
const taxRateSchema = z.object({
  id: z.string().max(180),
  taxClassId: z.string().max(180),
  taxRegionId: z.string().max(180).openapi({ description: "The region the rate applies in." }),
  name: z.string().max(120),
  rateBps: z.number().int(),
  priority: z.number().int(),
  isCompound: z.boolean(),
  combinable: z.boolean().openapi({ description: "Applies with the broader regions' rates of its class instead of replacing them." }),
  isActive: z.boolean(),
  version: z.number().int(),
  createdAt: nullableTimestampSchema,
  updatedAt: nullableTimestampSchema,
});
const providerIdSchema = z.string().trim().min(1).max(120)
  .openapi({ description: "`system` (the store's rates by region) or an installed app's tax provider, `<plugin id>:<provider id>`." });
const taxRegionSchema = z.object({
  id: z.string().max(180),
  countryCode: z.string().length(2),
  kind: z.enum(["country", "admin_area", "postal_prefix", "place"])
    .openapi({ description: "`country` is where the store collects tax; the others are regions of it." }),
  adminArea: z.string().max(120).nullable(),
  postalPrefix: z.string().max(10).nullable(),
  placeType: z.enum(["city", "zone", "area"]).nullable(),
  placeId: z.string().max(180).nullable(),
  placeName: z.string().max(180).nullable(),
  providerId: z.string().max(120).nullable().openapi({ description: "A country's tax provider; null uses the store-wide one." }),
  rateCount: z.number().int().nonnegative(),
  version: z.number().int(),
  createdAt: nullableTimestampSchema,
  updatedAt: nullableTimestampSchema,
});
const taxSettingsSchema = z.object({
  id: z.literal("default"),
  enabled: z.boolean(),
  taxShipping: z.boolean(),
  defaultTaxClassId: z.string().nullable(),
  shippingTaxClassId: z.string().nullable(),
  displayLabel: z.string().max(80),
  providerId: z.string().max(120),
  version: z.number().int(),
  createdAt: nullableTimestampSchema,
  updatedAt: nullableTimestampSchema,
});
const taxConfigurationSchema = z.object({
  settings: taxSettingsSchema,
  classes: z.array(taxClassSchema),
  regions: z.array(taxRegionSchema),
  rates: z.array(taxRateSchema),
  jurisdictions: z.array(z.object({
    id: z.string().max(180),
    name: z.string().max(120),
    type: z.enum(["city", "zone", "area"]),
    parentId: z.string().max(180).nullable(),
  })),
});

const boundedTaxListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  search: z.string().trim().max(180).optional(),
});

const taxJurisdictionSchema = z.object({
  id: z.string().max(180),
  name: z.string().max(120),
  type: z.enum(["city", "zone", "area"]),
  parentId: z.string().max(180).nullable(),
});

const getConfigurationRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "dashboard.taxes.configuration_get",
  tags: ["Admin - Taxes"],
  summary: "Get the legacy aggregate tax configuration",
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
    regions: configuration.regions.map(serializeTaxRegion),
    rates: configuration.rates.map(serializeTaxRate),
  });
});

const getSettingsRoute = createRoute({
  method: "get",
  path: "/settings",
  operationId: "dashboard.taxes.settings_get",
  tags: ["Admin - Taxes"],
  summary: "Get versioned tax settings",
  responses: {
    200: { description: "Tax settings", content: { "application/json": { schema: successEnvelope(z.object({ settings: taxSettingsSchema })) } } },
    ...errorResponses,
  },
});

app.openapi(getSettingsRoute, async (c) => {
  const settings = await getTaxSettingsDocument(c.get("db"));
  return ok(c, { settings: serializeTaxSettings(settings) });
});

const updateSettingsBodySchema = z.object({
  expectedVersion: z.number().int().min(0),
  enabled: z.boolean(),
  taxShipping: z.boolean(),
  defaultTaxClassId: z.string().max(180).nullable(),
  shippingTaxClassId: z.string().max(180).nullable(),
  displayLabel: z.string().trim().min(1).max(80),
  providerId: providerIdSchema.optional().openapi({ description: "The store-wide tax provider; omitted keeps the saved one." }),
}).strict();

const updateSettingsRoute = createRoute({
  method: "put",
  path: "/settings",
  operationId: "dashboard.taxes.settings_update",
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
  const body = c.req.valid("json");
  await assertTaxProvider(c.get("db"), body.providerId);
  const settings = await updateTaxSettings(c.get("db"), body);

  return ok(c, { settings: serializeTaxSettings(settings) });
});

const createClassBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional().nullable(),
  isExempt: z.boolean().optional().default(false),
}).strict();

const listClassesRoute = createRoute({
  method: "get",
  path: "/classes",
  operationId: "dashboard.taxes.classes_list",
  tags: ["Admin - Taxes"],
  summary: "List active tax classes with bounded pagination",
  request: { query: boundedTaxListQuerySchema },
  responses: {
    200: { description: "Tax classes", content: { "application/json": { schema: successEnvelope(z.object({
      items: z.array(taxClassSchema).max(50),
      total: z.number().int().nonnegative(),
      page: z.number().int().positive(),
      limit: z.number().int().min(1).max(50),
    })) } } },
    ...errorResponses,
  },
});

app.openapi(listClassesRoute, async (c) => {
  const query = c.req.valid("query");
  const result = await listTaxClasses(c.get("db"), query);
  return ok(c, {
    items: result.items.map(serializeTaxClass),
    total: result.total,
    page: query.page,
    limit: query.limit,
  });
});
const updateClassBodySchema = z.object({
  expectedVersion: z.number().int().min(1),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional().nullable(),
  isExempt: z.boolean().optional(),
}).strict();

const createClassRoute = createRoute({
  method: "post",
  path: "/classes",
  operationId: "dashboard.taxes.classes_create",
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

  return created(c, { taxClass: serializeTaxClass(taxClass) });
});

const updateClassRoute = createRoute({
  method: "put",
  path: "/classes/{id}",
  operationId: "dashboard.taxes.classes_update",
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

  return ok(c, { taxClass: serializeTaxClass(taxClass) });
});

const versionQuerySchema = z.object({ expectedVersion: z.coerce.number().int().min(1) });
const deleteClassRoute = createRoute({
  method: "delete",
  path: "/classes/{id}",
  operationId: "dashboard.taxes.classes_delete",
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

  return ok(c, { taxClass: serializeTaxClass(taxClass) });
});

const rateBodySchema = z.object({
  taxClassId: z.string().min(1).max(180),
  taxRegionId: z.string().min(1).max(180),
  name: z.string().trim().min(1).max(120),
  rateBps: z.number().int().min(0).max(10_000),
  priority: z.number().int().min(0).max(1_000).optional().default(0),
  isCompound: z.boolean().optional().default(false),
  combinable: z.boolean().optional().default(false),
  isActive: z.boolean().optional().default(true),
}).strict();

const listRatesRoute = createRoute({
  method: "get",
  path: "/rates",
  operationId: "dashboard.taxes.rates_list",
  tags: ["Admin - Taxes"],
  summary: "List active tax rates with bounded pagination",
  request: { query: boundedTaxListQuerySchema.extend({
    taxClassId: z.string().trim().min(1).max(180).optional(),
    taxRegionId: z.string().trim().min(1).max(180).optional(),
  }) },
  responses: {
    200: { description: "Tax rates", content: { "application/json": { schema: successEnvelope(z.object({
      items: z.array(taxRateSchema).max(50),
      total: z.number().int().nonnegative(),
      page: z.number().int().positive(),
      limit: z.number().int().min(1).max(50),
    })) } } },
    ...errorResponses,
  },
});

app.openapi(listRatesRoute, async (c) => {
  const query = c.req.valid("query");
  const result = await listTaxRates(c.get("db"), query);
  return ok(c, {
    items: result.items.map(serializeTaxRate),
    total: result.total,
    page: query.page,
    limit: query.limit,
  });
});
const updateRateBodySchema = z.object({
  expectedVersion: z.number().int().min(1),
  taxClassId: z.string().min(1).max(180).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  rateBps: z.number().int().min(0).max(10_000).optional(),
  taxRegionId: z.string().min(1).max(180).optional(),
  priority: z.number().int().min(0).max(1_000).optional(),
  isCompound: z.boolean().optional(),
  combinable: z.boolean().optional(),
  isActive: z.boolean().optional(),
}).strict();

const createRateRoute = createRoute({
  method: "post",
  path: "/rates",
  operationId: "dashboard.taxes.rates_create",
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

  return created(c, { taxRate: serializeTaxRate(taxRate) });
});

const updateRateRoute = createRoute({
  method: "put",
  path: "/rates/{id}",
  operationId: "dashboard.taxes.rates_update",
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

  return ok(c, { taxRate: serializeTaxRate(taxRate) });
});

const deleteRateRoute = createRoute({
  method: "delete",
  path: "/rates/{id}",
  operationId: "dashboard.taxes.rates_delete",
  tags: ["Admin - Taxes"],
  summary: "Delete a tax rate (orders keep their own copy)",
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

  return ok(c, { taxRate: serializeTaxRate(taxRate) });
});

// ── Regions ─────────────────────────────────────────────────────────────

const listRegionsRoute = createRoute({
  method: "get",
  path: "/regions",
  operationId: "dashboard.taxes.regions_list",
  tags: ["Admin - Taxes"],
  summary: "List where the store collects tax: countries and their regions",
  request: { query: z.object({ countryCode: z.string().trim().length(2).optional() }) },
  responses: {
    200: { description: "Tax regions", content: { "application/json": { schema: successEnvelope(z.object({
      regions: z.array(taxRegionSchema).max(2_000),
    })) } } },
    ...errorResponses,
  },
});
app.openapi(listRegionsRoute, async (c) => ok(c, {
  regions: (await listTaxRegions(c.get("db"), c.req.valid("query"))).map(serializeTaxRegion),
}));

const getRegionRoute = createRoute({
  method: "get",
  path: "/regions/{id}",
  operationId: "dashboard.taxes.regions_get",
  tags: ["Admin - Taxes"],
  summary: "Get a tax region with its rates and, for a country, its regions",
  request: { params: z.object({ id: z.string().min(1).max(180) }) },
  responses: {
    200: { description: "Tax region", content: { "application/json": { schema: successEnvelope(z.object({
      region: taxRegionSchema,
      subRegions: z.array(taxRegionSchema),
      rates: z.array(taxRateSchema),
    })) } } },
    ...errorResponses,
  },
});
app.openapi(getRegionRoute, async (c) => {
  const detail = await getTaxRegion(c.get("db"), c.req.valid("param").id);
  return ok(c, {
    region: serializeTaxRegion(detail.region),
    subRegions: detail.subRegions.map(serializeTaxRegion),
    rates: detail.rates.map(serializeTaxRate),
  });
});

const createRegionRoute = createRoute({
  method: "post",
  path: "/regions",
  operationId: "dashboard.taxes.regions_create",
  tags: ["Admin - Taxes"],
  summary: "Start collecting tax in a country, or add a region of one",
  description: "A country is the registration; an address in a country without one pays no tax. A region of a country (an admin area of its address rules, a postal-code prefix, or a Bangladesh City/Thana/Area place) needs the country first. Rates are added to a region afterwards.",
  request: { body: { required: true, content: { "application/json": { schema: z.object({
    countryCode: z.string().trim().length(2),
    adminArea: z.string().trim().max(120).nullable().optional(),
    postalPrefix: z.string().trim().max(20).nullable().optional(),
    placeId: z.string().trim().max(180).nullable().optional()
      .openapi({ description: "A Bangladesh delivery location (dashboard.taxes.jurisdictions_list)." }),
    providerId: providerIdSchema.nullable().optional(),
  }).strict() } } } },
  responses: {
    201: { description: "Tax region created", content: { "application/json": { schema: successEnvelope(z.object({ region: taxRegionSchema })) } } },
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    409: conflictResponse,
  },
});
app.openapi(createRegionRoute, async (c) => {
  const body = c.req.valid("json");
  await assertTaxProvider(c.get("db"), body.providerId);
  return created(c, { region: serializeTaxRegion(await createTaxRegion(c.get("db"), body)) });
});

const updateRegionRoute = createRoute({
  method: "put",
  path: "/regions/{id}",
  operationId: "dashboard.taxes.regions_update",
  tags: ["Admin - Taxes"],
  summary: "Choose a country's tax provider",
  request: {
    params: z.object({ id: z.string().min(1).max(180) }),
    body: { required: true, content: { "application/json": { schema: z.object({
      expectedVersion: z.number().int().min(1),
      providerId: providerIdSchema.nullable().openapi({ description: "Null uses the store-wide provider." }),
    }).strict() } } },
  },
  responses: {
    200: { description: "Tax region updated", content: { "application/json": { schema: successEnvelope(z.object({ region: taxRegionSchema })) } } },
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: conflictResponse,
  },
});
app.openapi(updateRegionRoute, async (c) => {
  const body = c.req.valid("json");
  await assertTaxProvider(c.get("db"), body.providerId);
  return ok(c, { region: serializeTaxRegion(await updateTaxRegion(c.get("db"), c.req.valid("param").id, body)) });
});

const deleteRegionRoute = createRoute({
  method: "delete",
  path: "/regions/{id}",
  operationId: "dashboard.taxes.regions_delete",
  tags: ["Admin - Taxes"],
  summary: "Stop collecting tax in a region (a country takes its regions and every rate along)",
  request: { params: z.object({ id: z.string().min(1).max(180) }), query: versionQuerySchema },
  responses: {
    200: { description: "Tax region deleted", content: { "application/json": { schema: successEnvelope(z.object({
      id: z.string(),
      countryCode: z.string(),
    })) } } },
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: conflictResponse,
  },
});
app.openapi(deleteRegionRoute, async (c) => ok(c, await deleteTaxRegion(
  c.get("db"),
  c.req.valid("param").id,
  c.req.valid("query").expectedVersion,
)));

const listJurisdictionsRoute = createRoute({
  method: "get",
  path: "/jurisdictions",
  operationId: "dashboard.taxes.jurisdictions_list",
  tags: ["Admin - Taxes"],
  summary: "List active tax jurisdictions with bounded pagination",
  request: { query: boundedTaxListQuerySchema.extend({
    type: z.enum(["city", "zone", "area"]).optional(),
    parentId: z.string().trim().min(1).max(180).optional(),
  }) },
  responses: {
    200: { description: "Tax jurisdictions", content: { "application/json": { schema: successEnvelope(z.object({
      items: z.array(taxJurisdictionSchema).max(50),
      total: z.number().int().nonnegative(),
      page: z.number().int().positive(),
      limit: z.number().int().min(1).max(50),
    })) } } },
    ...errorResponses,
  },
});

app.openapi(listJurisdictionsRoute, async (c) => {
  const query = c.req.valid("query");
  const result = await listTaxJurisdictions(c.get("db"), query);
  return ok(c, {
    items: result.items,
    total: result.total,
    page: query.page,
    limit: query.limit,
  });
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
  operationId: "dashboard.taxes.classifications_list",
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
  operationId: "dashboard.taxes.classifications_update",
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

  return ok(c, { classification });
});

const previewRoute = createRoute({
  method: "post",
  path: "/preview",
  operationId: "dashboard.taxes.preview",
  tags: ["Admin - Taxes"],
  summary: "Preview the tax of a sample order at an address, server-side",
  description: "Uses the saved regions, rates and provider, and the market of the address's country for whether prices include tax. A Bangladesh address names its City and Thana (and Area); another country's names its admin area or postal code. Without an address the order is taxed where the store ships from.",
  request: { body: { required: true, content: { "application/json": { schema: z.object({
    amount: z.number().min(0).max(1_000_000_000),
    quantity: z.number().int().min(1).max(99).default(1),
    taxClassId: z.string().max(180).nullable().optional(),
    shippingAmount: z.number().min(0).max(1_000_000_000).default(0),
    discountAmount: z.number().min(0).max(1_000_000_000).default(0),
    countryCode: z.string().trim().length(2).nullable().optional(),
    adminArea: z.string().trim().max(120).nullable().optional(),
    postalCode: z.string().trim().max(40).nullable().optional(),
    city: z.string().min(1).max(180).nullable().optional(),
    zone: z.string().min(1).max(180).nullable().optional(),
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
      countryCode: z.string().length(2).openapi({ description: "The country taxed." }),
      providerId: z.string().openapi({ description: "The provider that calculated." }),
      taxRegionId: z.string().nullable().openapi({ description: "The most specific region whose rates applied to the item." }),
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
  const city = body.city?.trim() || null;
  const zone = body.zone?.trim() || null;
  const area = body.area?.trim() || null;
  const locationNames = city
    ? await resolveActiveDeliveryLocationNames(db, { city, zone: zone ?? "", area })
    : { cityName: null, zoneName: null, areaName: null };
  const hasAddress = Boolean(city || body.countryCode);
  const currency = await readStoreCurrency(db);
  const quote = await calculateStorefrontTaxQuote(db, {
    destination: {
      city,
      zone,
      area,
      ...locationNames,
      ...(hasAddress ? {
        countryCode: body.countryCode?.toUpperCase() ?? null,
        adminArea: body.adminArea ?? null,
        postalCode: body.postalCode ?? null,
      } : {}),
    },
    lines: [{
      lineId: "preview",
      productId: "preview",
      variantId: "preview",
      unitPriceMinor: toMinor(body.amount, currency.decimalPlaces),
      quantity: body.quantity,
      taxClassId: body.taxClassId ?? null,
    }],
    shippingMinor: toMinor(body.shippingAmount, currency.decimalPlaces),
    discountMinor: toMinor(body.discountAmount, currency.decimalPlaces),
    currency: { code: currency.code, decimalPlaces: currency.decimalPlaces, priceIncrementMinor: currency.priceIncrementMinor },
  }, undefined, { apps: requestAppProviders(c) });
  return ok(c, {
    displayLabel: quote.displayLabel,
    pricesIncludeTax: quote.pricesIncludeTax,
    currencyCode: quote.currencyCode,
    decimalPlaces: quote.decimalPlaces,
    taxAmount: fromMinor(quote.taxMinor, quote.decimalPlaces),
    taxMinor: quote.taxMinor,
    totalAmount: fromMinor(quote.totalMinor, quote.decimalPlaces),
    totalMinor: quote.totalMinor,
    countryCode: quote.jurisdiction.countryCode,
    providerId: quote.jurisdiction.providerId,
    taxRegionId: quote.lines[0]?.taxRegionId ?? null,
    components: [
      ...quote.lines.flatMap((line) => line.components),
      ...quote.shipping.components,
    ],
  });
});

export { app as adminTaxRoutes };
