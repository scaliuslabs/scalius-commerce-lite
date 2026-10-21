// Agent operation registry rows for the dashboard brand routes.
import type { OperationRegistryEntry } from "./entry";

export const DASHBOARD_BRAND_OPERATIONS = {
  // Many creates per call for importers: per-item keys, bounded by plan (resources-batch.ts).
  "dashboard.brands.batch_create": {
    idempotency: "supported",
    batch: "forbidden",
    uncurated: true,
  },
  "dashboard.brands.create": {},
  "dashboard.brands.delete_permanently": { risk: "destructive", revision: "required" },
  "dashboard.brands.form_options": {},
  "dashboard.brands.get": {},
  // Page-numbered (dashboard-shaped): beta until a cursor list joins the stable API.
  "dashboard.brands.list": {},
  "dashboard.brands.restore": { revision: "required" },
  "dashboard.brands.set_status": { revision: "required" },
  "dashboard.brands.trash": { risk: "destructive", revision: "required" },
  "dashboard.brands.update": { revision: "required" },
} satisfies Record<string, OperationRegistryEntry>;
