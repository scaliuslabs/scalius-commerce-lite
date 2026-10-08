// Agent operation registry rows for metaobjects (content types and their
// entries). Every write is guarded by the revision the caller read; deleting
// a content type deletes its entries.
import type { OperationRegistryEntry } from "./entry";

export const DASHBOARD_METAOBJECT_OPERATIONS = {
  "dashboard.metaobjects.definitions_list": {},
  "dashboard.metaobjects.definitions_get": {},
  "dashboard.metaobjects.definitions_create": {},
  "dashboard.metaobjects.definitions_update": { revision: "required" },
  "dashboard.metaobjects.definitions_delete": { risk: "destructive", revision: "required" },
  "dashboard.metaobjects.entries_list": {},
  "dashboard.metaobjects.entries_get": {},
  "dashboard.metaobjects.entries_create": {},
  "dashboard.metaobjects.entries_update": { revision: "required" },
  "dashboard.metaobjects.entries_delete": { risk: "destructive", revision: "required" },
} satisfies Record<string, OperationRegistryEntry>;
