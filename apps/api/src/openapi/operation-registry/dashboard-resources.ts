// Agent operation registry rows for the stable app API's resources
// (routes/admin/resources.ts, README.md beside this file): reads return the
// sealed webhook representations, writes take integer minor units.
import type { OperationRegistryEntry } from "./entry";

export const DASHBOARD_RESOURCE_OPERATIONS = {
  "dashboard.resources.orders.list": { stability: "stable", uncurated: true },
  "dashboard.resources.orders.get": { stability: "stable", uncurated: true },
  "dashboard.resources.payments.list": { stability: "stable", uncurated: true },
  "dashboard.resources.fulfillments.list": { stability: "stable", uncurated: true },
  // The fulfilment ledger's own request key carries the Idempotency-Key.
  "dashboard.resources.fulfillments.create": {
    stability: "stable",
    idempotency: "supported",
    batch: "forbidden",
    uncurated: true,
  },
  "dashboard.resources.shipments.list": { stability: "stable", uncurated: true },
  "dashboard.resources.shipments.get": { stability: "stable", uncurated: true },
  "dashboard.resources.shipments.create": {
    stability: "stable",
    openWorld: true,
    batch: "forbidden",
    uncurated: true,
  },
  "dashboard.resources.products.list": { stability: "stable", uncurated: true },
  "dashboard.resources.products.get": { stability: "stable", uncurated: true },
  "dashboard.resources.variants.get": { stability: "stable", uncurated: true },
  "dashboard.resources.customers.list": { stability: "stable", uncurated: true },
  "dashboard.resources.customers.get": { stability: "stable", uncurated: true },
  // Price lists (MARKETS-DESIGN D5), in minor units of the list's currency.
  "dashboard.resources.price_lists.list": { stability: "stable", uncurated: true },
  "dashboard.resources.price_lists.get": { stability: "stable", uncurated: true },
  "dashboard.resources.price_lists.create": { stability: "stable", uncurated: true },
  "dashboard.resources.price_lists.update": { stability: "stable", revision: "required", uncurated: true },
  "dashboard.resources.price_lists.delete": { stability: "stable", risk: "destructive", revision: "required", uncurated: true },
  "dashboard.resources.price_lists.prices_list": { stability: "stable", uncurated: true },
  "dashboard.resources.price_lists.prices_set": {
    stability: "stable",
    revision: "required",
    limits: { request: 262_144 },
    uncurated: true,
  },
} satisfies Record<string, OperationRegistryEntry>;
