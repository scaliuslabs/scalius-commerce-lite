// Agent operation registry rows for the dashboard customer routes.
import type { OperationRegistryEntry } from "./entry";

export const DASHBOARD_CUSTOMER_OPERATIONS = {
  "dashboard.customers.bulk_delete": {
    risk: "destructive",
    batch: "forbidden",
  },
  "dashboard.customers.create": {},
  "dashboard.customers.delete": { risk: "destructive" },
  "dashboard.customers.delete_permanently": {
    risk: "destructive",
    batch: "forbidden",
  },
  "dashboard.customers.get": {},
  "dashboard.customers.history": {},
  "dashboard.customers.list": {},
  "dashboard.customers.restore": {},
  "dashboard.customers.update": {},
} satisfies Record<string, OperationRegistryEntry>;
