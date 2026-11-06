// Agent operation registry rows for the dashboard inventory routes.
import type { OperationRegistryEntry } from "./entry";

export const DASHBOARD_INVENTORY_OPERATIONS = {
  "dashboard.inventory_alerts.acknowledge": {},
  "dashboard.inventory_alerts.list": {},
  "dashboard.inventory_labels.generate_artifact": {
    risk: "read",
    batch: "forbidden",
    artifact: {
      mediaTypes: ["application/pdf", "text/csv", "text/html"],
      disposition: "attachment",
      filenamePolicy: "content-disposition",
      maxArtifactBytes: 16 * 1024 * 1024,
      delivery: "authenticated-handle",
    },
  },
  "dashboard.inventory_labels.preview": { risk: "read" },
  "dashboard.inventory.adjust": { idempotency: "required", revision: "optional" },
  "dashboard.inventory.adjust_stock": { idempotency: "required" },
  "dashboard.inventory.list": {},
  "dashboard.inventory.lookup_sku": {},
  "dashboard.inventory.movements_export": {
    risk: "read",
    batch: "forbidden",
    limits: { request: 16_384 },
    artifact: {
      mediaTypes: ["text/csv"],
      disposition: "attachment",
      filenamePolicy: "content-disposition",
      maxArtifactBytes: 16 * 1024 * 1024,
      delivery: "authenticated-handle",
    },
  },
  "dashboard.inventory.set_stock": { idempotency: "required", revision: "optional" },
  "dashboard.inventory.set_alert_level": {},
  "dashboard.inventory.set_default_alert_level": {},
  "dashboard.inventory.levels": {},
  "dashboard.inventory.product_levels": {},
  "dashboard.inventory_locations.list": {},
  "dashboard.inventory_locations.create": {},
  "dashboard.inventory_locations.update": { revision: "required" },
  "dashboard.inventory_locations.archive": { risk: "destructive" },
  "dashboard.inventory_locations.unarchive": {},
  "dashboard.inventory_locations.set_default": {},
  // Valuation and unit costs (0109).
  "dashboard.inventory.valuation": {},
  "dashboard.inventory.set_costs": {},
  // Suppliers (0109).
  "dashboard.inventory_suppliers.list": {},
  "dashboard.inventory_suppliers.get": {},
  "dashboard.inventory_suppliers.create": {},
  "dashboard.inventory_suppliers.update": { revision: "required" },
  "dashboard.inventory_suppliers.archive": { risk: "destructive" },
  "dashboard.inventory_suppliers.unarchive": {},
  // Purchase orders (0109). Receiving moves stock under an operation key;
  // edits and status changes carry the document revision.
  "dashboard.purchase_orders.list": {},
  "dashboard.purchase_orders.get": {},
  "dashboard.purchase_orders.create": {},
  "dashboard.purchase_orders.update": { revision: "required" },
  "dashboard.purchase_orders.mark_ordered": { revision: "required" },
  "dashboard.purchase_orders.receive": { idempotency: "required" },
  "dashboard.purchase_orders.cancel": { risk: "destructive", revision: "required" },
  "dashboard.purchase_orders.delete": { risk: "destructive", revision: "required" },
  "dashboard.purchase_orders.export": {
    batch: "forbidden",
    artifact: {
      mediaTypes: ["text/csv"],
      disposition: "attachment",
      filenamePolicy: "content-disposition",
      maxArtifactBytes: 1024 * 1024,
      delivery: "authenticated-handle",
    },
  },
  // Transfers between locations (0109): shipping, receiving and cancelling
  // in transit move stock under an operation key.
  "dashboard.inventory_transfers.list": {},
  "dashboard.inventory_transfers.get": {},
  "dashboard.inventory_transfers.create": {},
  "dashboard.inventory_transfers.update": { revision: "required" },
  "dashboard.inventory_transfers.ship": { idempotency: "required", revision: "required" },
  "dashboard.inventory_transfers.receive": { idempotency: "required" },
  "dashboard.inventory_transfers.cancel": { risk: "destructive", idempotency: "required", revision: "required" },
  "dashboard.inventory_transfers.delete": { risk: "destructive", revision: "required" },
  // The stable app API's stock documents (routes/admin/resources-inventory.ts):
  // the same inventory services as above, minor units in and out, the sealed
  // purchase_order and inventory_transfer representations. Stock commands
  // derive their operation key from the required Idempotency-Key.
  "dashboard.resources.inventory_levels.list": { uncurated: true },
  "dashboard.resources.suppliers.list": { uncurated: true },
  "dashboard.resources.suppliers.get": { uncurated: true },
  "dashboard.resources.suppliers.create": { batch: "forbidden", uncurated: true },
  "dashboard.resources.suppliers.update": { revision: "required", batch: "forbidden", uncurated: true },
  "dashboard.resources.purchase_orders.list": { uncurated: true },
  "dashboard.resources.purchase_orders.get": { uncurated: true },
  "dashboard.resources.purchase_orders.create": { batch: "forbidden", uncurated: true },
  "dashboard.resources.purchase_orders.update": { revision: "required", batch: "forbidden", uncurated: true },
  "dashboard.resources.purchase_orders.mark_ordered": { revision: "required", batch: "forbidden", uncurated: true },
  "dashboard.resources.purchase_orders.receive": { idempotency: "required", batch: "forbidden", uncurated: true },
  // Cancelling a document is a write (what was received stays): agents still confirm it.
  "dashboard.resources.purchase_orders.cancel": { confirmation: "required", revision: "required", batch: "forbidden", uncurated: true },
  "dashboard.resources.inventory_transfers.list": { uncurated: true },
  "dashboard.resources.inventory_transfers.get": { uncurated: true },
  "dashboard.resources.inventory_transfers.create": { batch: "forbidden", uncurated: true },
  "dashboard.resources.inventory_transfers.update": { revision: "required", batch: "forbidden", uncurated: true },
  "dashboard.resources.inventory_transfers.ship": { idempotency: "required", revision: "required", batch: "forbidden", uncurated: true },
  "dashboard.resources.inventory_transfers.receive": { idempotency: "required", batch: "forbidden", uncurated: true },
  "dashboard.resources.inventory_transfers.cancel": { confirmation: "required", idempotency: "required", revision: "required", batch: "forbidden", uncurated: true },
} satisfies Record<string, OperationRegistryEntry>;
