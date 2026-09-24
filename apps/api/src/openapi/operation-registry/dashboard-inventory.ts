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
  "dashboard.inventory.adjust": { idempotency: "required" },
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
  "dashboard.inventory.set_stock": { idempotency: "required" },
  "dashboard.inventory.set_alert_level": {},
  "dashboard.inventory.set_default_alert_level": {},
} satisfies Record<string, OperationRegistryEntry>;
