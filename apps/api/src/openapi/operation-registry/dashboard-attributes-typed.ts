// Agent operation registry rows for the dashboard typed-attribute routes:
// spec groups, the id-based value vocabulary, value-type conversion and
// category attribute sets (apps/api/src/routes/admin/attributes-typed.ts).
import type { OperationRegistryEntry } from "./entry";

export const DASHBOARD_ATTRIBUTE_TYPED_OPERATIONS = {
  "dashboard.attribute_groups.create": {},
  "dashboard.attribute_groups.list": {},
  "dashboard.attribute_groups.reorder": {},
  "dashboard.attribute_groups.trash": { risk: "destructive" },
  "dashboard.attribute_groups.update": {},
  "dashboard.attribute_sets.get": {},
  "dashboard.attribute_sets.replace": {},
  "dashboard.attribute_values.create_normalized": {},
  "dashboard.attribute_values.delete_by_id": { risk: "destructive" },
  "dashboard.attribute_values.list_normalized": {},
  "dashboard.attribute_values.reorder": {},
  "dashboard.attribute_values.update_by_id": {},
  "dashboard.attributes.convert_type": {},
} satisfies Record<string, OperationRegistryEntry>;
