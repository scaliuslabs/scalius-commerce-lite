// Agent operation registry rows for the storefront agent context and continuation routes.
import type { OperationRegistryEntry } from "./entry";

export const STOREFRONT_AGENT_OPERATIONS = {
  "storefront.context.close": { revision: "required" },
  "storefront.context.create": {},
  "storefront.context.get": {},
  "storefront.continuations.get": { exposure: "continuation" },
} satisfies Record<string, OperationRegistryEntry>;
