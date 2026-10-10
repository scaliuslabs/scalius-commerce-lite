// Agent operation registry rows for the dashboard customer routes.
import type { OperationRegistryEntry } from "./entry";

export const DASHBOARD_CUSTOMER_OPERATIONS = {
  "dashboard.customers.bulk_delete": {
    risk: "destructive",
    batch: "forbidden",
  },
  "dashboard.customers.bulk_restore": {},
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
  // The address book (MARKETS-DESIGN D7).
  "dashboard.customers.addresses_create": {},
  "dashboard.customers.addresses_delete": { risk: "destructive" },
  "dashboard.customers.addresses_list": {},
  "dashboard.customers.addresses_set_default": {},
  "dashboard.customers.addresses_set_default_billing": {},
  "dashboard.customers.addresses_update": {},
  // Customers & marketing.
  "dashboard.customers.export": {
    batch: "forbidden",
    artifact: {
      mediaTypes: ["text/csv"],
      disposition: "attachment",
      filenamePolicy: "content-disposition",
      maxArtifactBytes: 16 * 1024 * 1024,
      delivery: "authenticated-handle",
    },
  },
  "dashboard.customers.marketing_get": {},
  "dashboard.customers.marketing_update": {},
  "dashboard.customers.segments_count": {},
  "dashboard.customers.segments_create": {},
  "dashboard.customers.segments_delete": { risk: "destructive" },
  "dashboard.customers.segments_get": {},
  "dashboard.customers.segments_list": {},
  "dashboard.customers.segments_members": {},
  "dashboard.customers.segments_preview": { risk: "read" },
  "dashboard.customers.segments_update": { revision: "required" },
  "dashboard.customers.tags_bulk_update": { batch: "sequential" },
  "dashboard.customers.tags_list": {},
  "dashboard.customers.tags_set": {},
} satisfies Record<string, OperationRegistryEntry>;
