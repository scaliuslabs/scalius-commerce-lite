import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { listDeliveryRatesForDestination } from "@scalius/core/modules/delivery";
import { getCurrencyConfig } from "@scalius/core/modules/settings";
import { fromMinor } from "@scalius/shared/money";

import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";
const app = new OpenAPIHono<{ Bindings: Env }>();

const locationId = z.string().trim().min(1).max(128).optional();

// GET /shipping-methods — the delivery rates offered for a destination
const listShippingMethodsRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "storefront.shipping_methods.list",
  tags: ["Shipping Methods"],
  summary: "List the delivery rates offered for a destination",
  description:
    "With a destination, returns the rates of the shipping zone it belongs to plus every local pickup rate (`kind: \"pickup\"`); no delivery rate means the store doesn't deliver there. A destination is Bangladesh's cityId (plus zoneId/areaId when chosen), or another country's countryCode with its adminArea and postalCode when known. Its zone is the most specific match: Bangladesh location, then postal-code prefix, then admin area, then the whole country. Without a destination, returns every active rate. `fee` is the rate's charge; checkout charges nothing once the items subtotal (before discounts) reaches `freeOver`. `countries` are the countries the rate's zone serves, `entire` when every address there gets this zone.",
  request: {
    query: z.object({
      countryCode: z.string().trim().regex(/^[A-Za-z]{2}$/, "Use a two-letter ISO country code.").optional(),
      cityId: locationId,
      zoneId: locationId,
      areaId: locationId,
      adminArea: z.string().trim().min(1).max(120).optional(),
      postalCode: z.string().trim().min(1).max(20).optional(),
    }),
  },
  responses: {
    200: {
      description: "Shipping methods list",
      content: { "application/json": { schema: successEnvelope(z.object({
        shippingMethods: z.array(z.object({
          id: z.string().max(128),
          name: z.string().max(100),
          fee: z.number().min(0),
          freeOver: z.number().min(0).nullable(),
          kind: z.enum(["delivery", "pickup"]),
          countries: z.array(z.object({
            code: z.string().length(2),
            entire: z.boolean().openapi({
              description: "True when every address in the country gets this rate's zone; false when only part of it does (a region, postal codes or Bangladesh delivery areas, or another zone holds part of it).",
            }),
          })).max(250).openapi({
            description: "The countries the rate's shipping zone serves. Empty for local pickup, which is offered to every buyer.",
          }),
          pickupAddress: z.string().max(500).nullable(),
          pickupHours: z.string().max(120).nullable(),
          description: z.string().max(255).nullable(),
          isActive: z.boolean(),
          sortOrder: z.number().int(),
          createdAt: z.string().nullable(),
        })).max(100),
      })) } },
    },
    400: errorResponses[400],
    500: errorResponses[500],
  }
});

app.openapi(listShippingMethodsRoute, async (c) => {
  const db = c.get("db");
  const { countryCode, cityId, zoneId, areaId, adminArea, postalCode } = c.req.valid("query");
  const foreign = countryCode !== undefined && countryCode.toUpperCase() !== "BD";
  // Bangladesh is a destination once its city is known; another country by itself.
  const destination = foreign
    ? { countryCode, adminArea, postalCode }
    : cityId ? { countryCode: "BD", city: cityId, zone: zoneId, area: areaId } : null;
  const [rates, { decimalPlaces }] = await Promise.all([
    listDeliveryRatesForDestination(db, destination),
    getCurrencyConfig(db),
  ]);

  return ok(c, {
    // zoneId and updatedAt are left out: they change without changing what a buyer sees.
    shippingMethods: rates.map(({ zoneId: _zoneId, feeMinor, freeOverMinor, createdAt, updatedAt: _updatedAt, ...rate }) => ({
      ...rate,
      fee: fromMinor(feeMinor, decimalPlaces),
      freeOver: freeOverMinor === null ? null : fromMinor(freeOverMinor, decimalPlaces),
      createdAt: createdAt instanceof Date ? createdAt.toISOString() : null,
    })),
  });
});

export { app as shippingMethodRoutes };
