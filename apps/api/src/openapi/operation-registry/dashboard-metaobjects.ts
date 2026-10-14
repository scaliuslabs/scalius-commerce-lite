// Agent operation registry rows for metaobjects (content types and their
// entries). Every write is guarded by the revision the caller read; deleting
// a content type deletes its entries.
import type { OperationRegistryEntry } from "./entry";

export const DASHBOARD_METAOBJECT_OPERATIONS = {
  "dashboard.metaobjects.definitions_list": { stability: "stable" },
  "dashboard.metaobjects.definitions_get": { stability: "stable" },
  "dashboard.metaobjects.definitions_create": {},
  "dashboard.metaobjects.definitions_update": { revision: "required" },
  "dashboard.metaobjects.definitions_delete": { risk: "destructive", revision: "required" },
  "dashboard.metaobjects.entries_list": { stability: "stable" },
  "dashboard.metaobjects.entries_get": { stability: "stable" },
  "dashboard.metaobjects.entries_create": { stability: "stable" },
  "dashboard.metaobjects.entries_update": { stability: "stable", revision: "required" },
  "dashboard.metaobjects.entries_delete": { stability: "stable", risk: "destructive", revision: "required" },
} satisfies Record<string, OperationRegistryEntry>;
