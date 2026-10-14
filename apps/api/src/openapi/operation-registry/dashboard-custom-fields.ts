// Agent operation registry rows for custom fields (COMMERCE-HOOKS H4).
// Definitions are store settings guarded by their revision; deleting one
// removes every value of it. Values are read and written per owner (one route
// pair per owner type, each under its owner's RBAC family) in one guarded
// batch (all or none), in the merchant's `custom` namespace only.
// Values are part of the stable app API (Shopify metafields): every owner type.
import { CUSTOM_FIELD_OWNER_TYPES } from "@scalius/shared/custom-fields";
import type { OperationRegistryEntry } from "./entry";

const VALUE_OPERATIONS: Record<string, OperationRegistryEntry> = Object.fromEntries(
  CUSTOM_FIELD_OWNER_TYPES.flatMap((ownerType) => [
    [`dashboard.custom_fields.get_${ownerType}_values`, { stability: "stable" }],
    [`dashboard.custom_fields.set_${ownerType}_values`, { stability: "stable" }],
  ]),
);

export const DASHBOARD_CUSTOM_FIELD_OPERATIONS = {
  "dashboard.custom_field_definitions.list": { stability: "stable" },
  "dashboard.custom_field_definitions.get": { stability: "stable" },
  "dashboard.custom_field_definitions.create": {},
  "dashboard.custom_field_definitions.update": { revision: "required" },
  "dashboard.custom_field_definitions.delete": { risk: "destructive", revision: "required" },
  "dashboard.custom_field_definitions.reorder": { revision: "required" },
  ...VALUE_OPERATIONS,
} satisfies Record<string, OperationRegistryEntry>;
