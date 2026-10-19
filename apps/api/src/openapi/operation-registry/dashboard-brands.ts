// Agent operation registry rows for the dashboard brand routes.
import type { OperationRegistryEntry } from "./entry";

export const DASHBOARD_BRAND_OPERATIONS = {
  "dashboard.brands.create": { stability: "stable", replay: true },
  "dashboard.brands.delete_permanently": { risk: "destructive", revision: "required" },
  "dashboard.brands.form_options": {},
  "dashboard.brands.get": { stability: "stable" },
  "dashboard.brands.list": { stability: "stable" },
  "dashboard.brands.restore": { stability: "stable", revision: "required" },
  "dashboard.brands.set_status": { stability: "stable", revision: "required" },
  "dashboard.brands.trash": { stability: "stable", risk: "destructive", revision: "required" },
  "dashboard.brands.update": { stability: "stable", revision: "required" },
} satisfies Record<string, OperationRegistryEntry>;
