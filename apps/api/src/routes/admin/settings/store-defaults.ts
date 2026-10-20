// Settings → Store details → Store defaults (time zone, unit system, default
// weight unit) and the store setup step after the first admin (country,
// currency, language, time zone, units). docs/STORE-DEFAULTS.md.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { TIME_ZONE_MAX_LENGTH } from "@scalius/shared/commerce-time";
import { SUPPORTED_CURRENCY_CODES } from "@scalius/shared/currency";
import { UNIT_SYSTEMS, WEIGHT_UNITS } from "@scalius/shared/store-defaults";
import { getStoreFormatting, saveStoreDefaults } from "@scalius/core/modules/platform";
import { settingsMirror } from "@scalius/core/settings-store";
import {
  STORE_NAME_MAX_LENGTH,
  applyStoreSetup,
  getStoreSetupStatus,
} from "@scalius/core/modules/onboarding";
import { ok } from "../../../utils/api-response";
import { rebuildCatalogProjectionsAfterWrite } from "../../../background/catalog";
import { successEnvelope, conflictResponse, errorResponses } from "../../../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();

const timeZoneSchema = z.string().trim().min(1).max(TIME_ZONE_MAX_LENGTH).openapi({
  description: "An IANA time zone, such as America/New_York or Asia/Dhaka. Days, weeks and months of reports, date filters and scheduled app jobs are store calendar days in it; daylight saving time is followed.",
});
const unitSystemSchema = z.enum(UNIT_SYSTEMS).openapi({ description: "metric (kilograms, grams) or imperial (pounds, ounces)." });
const weightUnitSchema = z.enum(WEIGHT_UNITS).openapi({
  description: "The unit the dashboard shows and accepts weights in: kg or g for metric, lb or oz for imperial. Weights are stored in grams.",
});

const storeDefaultsSchema = z.object({
  timeZone: z.string().max(TIME_ZONE_MAX_LENGTH),
  unitSystem: unitSystemSchema,
  weightUnit: weightUnitSchema,
  /** The platform document's revision (store defaults live there). */
  revision: z.number().int().nonnegative(),
});

const storeDefaultsReadSchema = storeDefaultsSchema.extend({
  countryCode: z.string().length(2).nullable().openapi({
    description: "The store's country (the backup market's, ISO 3166-1 alpha-2): numbers and dates are written, and weeks start, as there (CLDR). Null before the store has a market country.",
  }),
});

// ─────────────────────────────────────────
// Store defaults
// ─────────────────────────────────────────

const getStoreDefaultsRoute = createRoute({
  method: "get",
  path: "/store-defaults",
  tags: ["Admin - Settings"],
  summary: "Get store defaults",
  description: "The store's time zone, unit system and default weight unit (Settings → Store details → Store defaults), and its country.",
  operationId: "dashboard.settings.store_defaults_get",
  responses: {
    200: { description: "Store defaults", content: { "application/json": { schema: successEnvelope(storeDefaultsReadSchema) } } },
    ...errorResponses,
  },
});

app.openapi(getStoreDefaultsRoute, async (c) => {
  c.header("Cache-Control", "private, no-store");
  return ok(c, await getStoreFormatting(c.get("db")));
});

const saveStoreDefaultsRoute = createRoute({
  method: "post",
  path: "/store-defaults",
  tags: ["Admin - Settings"],
  summary: "Save store defaults",
  description: "Change the store's time zone, unit system or default weight unit. A new unit system without a weight unit uses the system's default (kg, lb). Past orders keep their instants; reports regroup them by the new zone's days.",
  operationId: "dashboard.settings.store_defaults_update",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            expectedRevision: z.number().int().nonnegative(),
            timeZone: timeZoneSchema.optional(),
            unitSystem: unitSystemSchema.optional(),
            weightUnit: weightUnitSchema.optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Store defaults saved", content: { "application/json": { schema: successEnvelope(storeDefaultsSchema) } } },
    409: conflictResponse,
    ...errorResponses,
  },
});

app.openapi(saveStoreDefaultsRoute, async (c) => {
  const { expectedRevision, ...patch } = c.req.valid("json");
  c.header("Cache-Control", "private, no-store");
  return ok(c, await saveStoreDefaults(c.get("db"), patch, settingsMirror(c.env), { expectedRevision }));
});

// ─────────────────────────────────────────
// Store setup (after the first admin)
// ─────────────────────────────────────────

const storeSetupValuesSchema = z.object({
  storeName: z.string().max(STORE_NAME_MAX_LENGTH),
  countryCode: z.string().length(2),
  currencyCode: z.enum(SUPPORTED_CURRENCY_CODES),
  locale: z.string().length(2),
  timeZone: z.string().max(TIME_ZONE_MAX_LENGTH),
  unitSystem: unitSystemSchema,
  weightUnit: weightUnitSchema,
});

const storeSetupStatusSchema = z.object({
  needed: z.boolean().openapi({ description: "True while the store is new: no order yet, and Settings → Markets untouched." }),
  done: z.enum(["has_orders", "markets_configured"]).nullable(),
  current: storeSetupValuesSchema,
  currencyLocked: z.boolean().openapi({ description: "Products or delivery methods exist, so setup keeps the current currency." }),
});

const getStoreSetupRoute = createRoute({
  method: "get",
  path: "/store-setup",
  tags: ["Admin - Settings"],
  summary: "Get store setup status",
  description: "Whether the new-store setup step still applies, and the store's current name, country, currency, language, time zone and units.",
  operationId: "dashboard.settings.store_setup_get",
  responses: {
    200: { description: "Store setup status", content: { "application/json": { schema: successEnvelope(storeSetupStatusSchema) } } },
    ...errorResponses,
  },
});

app.openapi(getStoreSetupRoute, async (c) => {
  c.header("Cache-Control", "private, no-store");
  const status = await getStoreSetupStatus(c.get("db"));
  return ok(c, { needed: status.needed, done: status.done, current: status.current, currencyLocked: status.currencyLocked });
});

const applyStoreSetupRoute = createRoute({
  method: "post",
  path: "/store-setup",
  tags: ["Admin - Settings"],
  summary: "Set up a new store",
  description: "Name a new store and set its country (the backup market's one country), currency (default: the country's), store language, time zone and units (default: the country's system) in one write. Creates no tax region and no shipping zone. A store that has an order or edited markets answers 409 store_setup_done and nothing changes.",
  operationId: "dashboard.settings.store_setup_apply",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            storeName: z.string().trim().min(1).max(STORE_NAME_MAX_LENGTH),
            countryCode: z.string().trim().length(2).openapi({ description: "ISO 3166-1 alpha-2, such as US or BD." }),
            currencyCode: z.string().trim().length(3).optional(),
            locale: z.string().trim().length(2).optional().openapi({ description: "The storefront's language: en or bn." }),
            timeZone: timeZoneSchema,
            unitSystem: unitSystemSchema.optional(),
            weightUnit: weightUnitSchema.optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Store set up", content: { "application/json": { schema: successEnvelope(storeSetupValuesSchema) } } },
    409: conflictResponse,
    ...errorResponses,
  },
});

app.openapi(applyStoreSetupRoute, async (c) => {
  const body = c.req.valid("json");
  const result = await applyStoreSetup(c.get("db"), body, settingsMirror(c.env));
  // Card prices follow the price increment (cents instead of whole taka):
  // rebuild the catalogue projections off the request path.
  if (result.priceIncrementChanged) {
    await rebuildCatalogProjectionsAfterWrite(c, c.get("db"), "store-setup");
  }
  c.header("Cache-Control", "private, no-store");
  return ok(c, result.values);
});

export { app as storeDefaultsSettingsRoutes };
export default app;
