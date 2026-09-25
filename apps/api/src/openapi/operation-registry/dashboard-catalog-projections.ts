// Agent operation registry rows for the dashboard catalogue projection routes.
import type { OperationRegistryEntry } from "./entry";

export const DASHBOARD_CATALOG_PROJECTION_OPERATIONS = {
  // Maintenance, not a merchant intent: the nightly cron queues the same rebuild.
  "dashboard.catalog_projections.rebuild": { internal: true, batch: "forbidden" },
} satisfies Record<string, OperationRegistryEntry>;
