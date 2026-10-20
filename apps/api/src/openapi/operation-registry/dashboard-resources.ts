// Agent operation registry rows for the stable app API's resources
// (routes/admin/resources.ts, README.md beside this file): reads return the
// sealed webhook representations, writes take integer minor units.
import type { OperationRegistryEntry } from "./entry";

export const DASHBOARD_RESOURCE_OPERATIONS = {
  "dashboard.resources.orders.list": { stability: "stable", uncurated: true },
  "dashboard.resources.orders.get": { stability: "stable", uncurated: true },
  // The manual-order attempt table replays a repeated Idempotency-Key exactly.
  "dashboard.resources.orders.create": { stability: "stable", batch: "forbidden", uncurated: true },
  "dashboard.resources.payments.list": { stability: "stable", uncurated: true },
  // A payment received against an invoice: the payment row's id is derived
  // from the required Idempotency-Key, so a repeat records nothing more.
  "dashboard.resources.payments.create": {
    stability: "stable",
    risk: "financial",
    idempotency: "required",
    revision: "optional",
    batch: "forbidden",
    uncurated: true,
  },
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
  "dashboard.resources.variants.lookup": { stability: "stable", risk: "read", uncurated: true },
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
  // Bulk runs (routes/admin/resources-bulk.ts): up to 5,000 items, dryRun
  // previews every item, one run per Idempotency-Key. Each item's optional
  // precondition is the revision it was read at (price, stockVersion,
  // aggregateRevision); tags and publications have none to compare.
  "dashboard.resources.variants.bulk_set_prices": bulkRun({ revision: "optional" }),
  "dashboard.resources.variants.bulk_set_stock": bulkRun({ revision: "optional" }),
  "dashboard.resources.customers.bulk_tag": bulkRun(),
  "dashboard.resources.products.bulk_set_status": bulkRun({ revision: "optional" }),
  "dashboard.resources.products.bulk_publish": bulkRun(),
  "dashboard.resources.bulk_runs.get": { stability: "stable" },
  "dashboard.resources.bulk_runs.list": { stability: "stable", uncurated: true },
} satisfies Record<string, OperationRegistryEntry>;

function bulkRun(overrides: Partial<OperationRegistryEntry> = {}): OperationRegistryEntry {
  return {
    stability: "stable",
    dryRun: "native",
    batch: "forbidden",
    limits: { request: 524_288 },
    ...overrides,
  };
}
