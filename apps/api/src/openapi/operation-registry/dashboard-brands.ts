// Agent operation registry rows for the dashboard brand routes.
import type { OperationRegistryEntry } from "./entry";

export const DASHBOARD_BRAND_OPERATIONS = {
  "dashboard.brands.create": {},
  "dashboard.brands.delete_permanently": { risk: "destructive", revision: "required" },
  "dashboard.brands.form_options": {},
  "dashboard.brands.get": {},
  "dashboard.brands.list": {},
  "dashboard.brands.restore": { revision: "required" },
  "dashboard.brands.set_status": { revision: "required" },
  "dashboard.brands.trash": { risk: "destructive", revision: "required" },
  "dashboard.brands.update": { revision: "required" },
} satisfies Record<string, OperationRegistryEntry>;
