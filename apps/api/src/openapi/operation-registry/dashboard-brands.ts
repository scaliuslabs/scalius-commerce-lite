// Agent operation registry rows for the dashboard brand routes.
import type { OperationRegistryEntry } from "./entry";

export const DASHBOARD_BRAND_OPERATIONS = {
  // Many creates per call for importers: per-item keys, bounded by plan (resources-batch.ts).
  "dashboard.brands.batch_create": {
    stability: "stable",
    idempotency: "supported",
    batch: "forbidden",
    uncurated: true,
  },
  "dashboard.brands.create": { stability: "stable" },
  "dashboard.brands.delete_permanently": { risk: "destructive", revision: "required" },
  "dashboard.brands.form_options": {},
  "dashboard.brands.get": { stability: "stable" },
  // Page-numbered (dashboard-shaped): beta until a cursor list joins the stable API.
  "dashboard.brands.list": {},
  "dashboard.brands.restore": { stability: "stable", revision: "required" },
  "dashboard.brands.set_status": { stability: "stable", revision: "required" },
  "dashboard.brands.trash": { stability: "stable", risk: "destructive", revision: "required" },
  "dashboard.brands.update": { stability: "stable", revision: "required" },
} satisfies Record<string, OperationRegistryEntry>;
