import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { listDeliveryRatesForAddress } from "@scalius/core/modules/delivery";
import { getCurrencyConfig } from "@scalius/core/modules/settings";
import { fromMinor } from "@scalius/shared/money";

import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";
const app = new OpenAPIHono<{ Bindings: Env }>();

const locationId = z.string().trim().min(1).max(128).optional();

// GET /shipping-methods — the delivery rates offered for an address
const listShippingMethodsRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "storefront.shipping_methods.list",
  tags: ["Shipping Methods"],
  summary: "List the delivery rates offered for an address",
  description:
    "With cityId (plus zoneId/areaId when chosen), returns the rates of the delivery zone that address resolves to plus every local pickup rate (`kind: \"pickup\"`); an empty list means the store doesn't deliver there. Without an address, returns every active rate. `fee` is the rate's charge; checkout charges nothing once the items subtotal (before discounts) reaches `freeOver`.",
  request: {
    query: z.object({
      cityId: locationId,
      zoneId: locationId,
      areaId: locationId,
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
          everywhereElse: z.boolean().openapi({
            description: "True for a rate that applies outside every delivery zone (the store's default rates); false for a rate of one delivery zone.",
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
  const { cityId, zoneId, areaId } = c.req.valid("query");
  const [rates, { decimalPlaces }] = await Promise.all([
    listDeliveryRatesForAddress(db, cityId ? { city: cityId, zone: zoneId, area: areaId } : null),
    getCurrencyConfig(db),
  ]);

  return ok(c, {
    // updatedAt is left out: it changes without changing what a buyer sees.
    shippingMethods: rates.map(({ zoneId, feeMinor, freeOverMinor, createdAt, updatedAt: _updatedAt, ...rate }) => ({
      ...rate,
      everywhereElse: zoneId === null,
      fee: fromMinor(feeMinor, decimalPlaces),
      freeOver: freeOverMinor === null ? null : fromMinor(freeOverMinor, decimalPlaces),
      createdAt: createdAt instanceof Date ? createdAt.toISOString() : null,
    })),
  });
});

export { app as shippingMethodRoutes };
