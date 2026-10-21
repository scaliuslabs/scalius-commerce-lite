// Agent operation registry rows for the stable app API's resources
// (routes/admin/resources.ts, README.md beside this file): reads return the
// sealed webhook representations, writes take integer minor units.
import type { OperationRegistryEntry } from "./entry";

export const DASHBOARD_RESOURCE_OPERATIONS = {
  "dashboard.resources.orders.list": { uncurated: true },
  "dashboard.resources.orders.get": { uncurated: true },
  // The manual-order attempt table replays a repeated Idempotency-Key exactly.
  "dashboard.resources.orders.create": { batch: "forbidden", uncurated: true },
  "dashboard.resources.payments.list": { uncurated: true },
  // A payment received against an invoice: the payment row's id is derived
  // from the required Idempotency-Key, so a repeat records nothing more.
  "dashboard.resources.payments.create": {
    risk: "financial",
    idempotency: "required",
    revision: "optional",
    batch: "forbidden",
    uncurated: true,
  },
  // Payments without the buyer (routes/admin/resources-payment-methods.ts):
  // a saved method charged off-session, an authorization captured or voided.
  // Each claims locally before the provider call under a key derived from
  // the required Idempotency-Key, so a repeat answers the first outcome.
  "dashboard.resources.payments.charge": { ...paymentCommand(), revision: "optional" },
  "dashboard.resources.payments.capture": paymentCommand(),
  "dashboard.resources.payments.void": paymentCommand(),
  // A customer's saved methods; the provider's reference never leaves the store.
  "dashboard.resources.payment_methods.list": { uncurated: true },
  "dashboard.resources.payment_methods.delete": {
    risk: "destructive",
    openWorld: true,
    idempotency: "required",
    batch: "forbidden",
    uncurated: true,
  },
  // Refunds (routes/admin/resources-refunds.ts): the dashboard refund command
  // in minor units with the order lines it is for; claimed before any
  // provider call, one refund per required Idempotency-Key.
  "dashboard.resources.refunds.list": { uncurated: true },
  "dashboard.resources.refunds.create": {
    risk: "financial",
    openWorld: true,
    idempotency: "required",
    batch: "forbidden",
    uncurated: true,
  },
  "dashboard.resources.fulfillments.list": { uncurated: true },
  // The fulfilment ledger's own request key carries the Idempotency-Key.
  "dashboard.resources.fulfillments.create": {
    idempotency: "supported",
    batch: "forbidden",
    uncurated: true,
  },
  "dashboard.resources.shipments.list": { uncurated: true },
  "dashboard.resources.shipments.get": { uncurated: true },
  "dashboard.resources.shipments.create": {
    openWorld: true,
    batch: "forbidden",
    uncurated: true,
  },
  "dashboard.resources.products.list": { uncurated: true },
  "dashboard.resources.products.get": { uncurated: true },
  // PIM sync (routes/admin/resources-products.ts): the editor's create and
  // base-section writes in minor units; stock stays with inventory.
  "dashboard.resources.products.create": { batch: "forbidden", uncurated: true },
  // An importer or PIM sync creates many products per call: an item's id derives
  // from its key, so it replays (routes/admin/resources-batch.ts); the bound is a plan value.
  "dashboard.resources.products.batch_create": {
    idempotency: "supported",
    batch: "forbidden",
    uncurated: true,
  },
  "dashboard.resources.products.update": { revision: "required", batch: "forbidden", uncurated: true },
  // An app permanently deletes the trashed content it created itself
  // (routes/admin/resources-app-content.ts); ownership is the platform's record.
  "dashboard.resources.app_content.delete": {
    risk: "destructive",
    batch: "forbidden",
    principals: ["admin"],
    uncurated: true,
  },
  // Theme draft writes (routes/admin/resources-theme.ts, write_themes): never
  // publish. Applying a template replaces the draft's look and homepage, so
  // agents confirm it; the replaced draft is kept as a restore point.
  "dashboard.resources.theme.get": { uncurated: true },
  "dashboard.resources.theme.apply_template": {
    risk: "destructive",
    revision: "required",
    batch: "forbidden",
    uncurated: true,
  },
  "dashboard.resources.theme.section_settings_set": {
    revision: "required",
    batch: "forbidden",
    limits: { request: 65_536 },
    uncurated: true,
  },
  // Whole-menu writes (routes/admin/resources-menus.ts, write_navigation).
  "dashboard.resources.menus.get": { uncurated: true },
  "dashboard.resources.menus.create": { batch: "forbidden", uncurated: true },
  "dashboard.resources.menus.update": { revision: "required", batch: "forbidden", uncurated: true },
  "dashboard.resources.variants.get": { uncurated: true },
  "dashboard.resources.variants.lookup": { risk: "read", uncurated: true },
  "dashboard.resources.customers.list": { uncurated: true },
  "dashboard.resources.customers.get": { uncurated: true },
  // Price lists (MARKETS-DESIGN D5), in minor units of the list's currency.
  "dashboard.resources.price_lists.list": { uncurated: true },
  "dashboard.resources.price_lists.get": { uncurated: true },
  "dashboard.resources.price_lists.create": { uncurated: true },
  "dashboard.resources.price_lists.update": { revision: "required", uncurated: true },
  "dashboard.resources.price_lists.delete": { risk: "destructive", revision: "required", uncurated: true },
  "dashboard.resources.price_lists.prices_list": { uncurated: true },
  "dashboard.resources.price_lists.prices_set": {
    revision: "required",
    limits: { request: 262_144 },
    uncurated: true,
  },
  // Gift cards (routes/admin/resources-gift-cards.ts): stored value, so every
  // write is financial and confirmation-gated for agents; an app needs the
  // Sensitive write_gift_cards. The code never leaves the store.
  "dashboard.resources.gift_cards.list": { uncurated: true },
  "dashboard.resources.gift_cards.get": { uncurated: true },
  "dashboard.resources.gift_cards.create": storedValue(),
  "dashboard.resources.gift_cards.adjust": storedValue({ revision: "required" }),
  "dashboard.resources.gift_cards.update": storedValue({ revision: "required" }),
  // An app's own webhook subscriptions (routes/admin/resources-webhooks.ts):
  // apps only (write_webhooks), within their approved hosts, topics and
  // customer data. Create returns the signing secret to the app once and
  // never replays it.
  "dashboard.resources.webhook_subscriptions.list": { limits: { response: 32_768 }, uncurated: true },
  "dashboard.resources.webhook_subscriptions.create": {
    batch: "forbidden",
    limits: { request: 16_384, response: 16_384 },
    uncurated: true,
  },
  "dashboard.resources.webhook_subscriptions.update": {
    revision: "required",
    batch: "forbidden",
    limits: { request: 16_384, response: 16_384 },
    uncurated: true,
  },
  "dashboard.resources.webhook_subscriptions.delete": {
    risk: "destructive",
    revision: "required",
    batch: "forbidden",
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
  "dashboard.resources.bulk_runs.get": {},
  "dashboard.resources.bulk_runs.list": { uncurated: true },
} satisfies Record<string, OperationRegistryEntry>;

function bulkRun(overrides: Partial<OperationRegistryEntry> = {}): OperationRegistryEntry {
  return {
    dryRun: "native",
    batch: "forbidden",
    limits: { request: 524_288 },
    ...overrides,
  };
}

function paymentCommand(): OperationRegistryEntry {
  return {
    risk: "financial",
    openWorld: true,
    idempotency: "required",
    batch: "forbidden",
    uncurated: true,
  };
}

function storedValue(overrides: Partial<OperationRegistryEntry> = {}): OperationRegistryEntry {
  return {
    risk: "financial",
    confirmation: "required",
    batch: "forbidden",
    uncurated: true,
    ...overrides,
  };
}
