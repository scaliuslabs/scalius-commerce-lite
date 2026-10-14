// Agent operation registry rows for the dashboard catalogue projection routes.
import type { OperationRegistryEntry } from "./entry";

export const DASHBOARD_CATALOG_PROJECTION_OPERATIONS = {
  // Maintenance, not a merchant intent: the nightly cron queues the same rebuild.
  "dashboard.catalog_projections.rebuild": { uncurated: true, stability: "internal", batch: "forbidden" },
  // Projection drift repair; nightly maintenance runs the sampled check.
  "dashboard.derived_projections.maintain": { uncurated: true, stability: "internal", batch: "forbidden" },
} satisfies Record<string, OperationRegistryEntry>;
