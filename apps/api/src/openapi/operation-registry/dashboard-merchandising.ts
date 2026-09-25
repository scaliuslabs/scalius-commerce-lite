// Agent operation registry rows for the catalogue merchandising routes (slice
// 1c): the store's EMI plans. Content blocks, bundles and the product page
// template are product sections (`dashboard.products.*_section`).
import type { OperationRegistryEntry } from "./entry";

export const DASHBOARD_MERCHANDISING_OPERATIONS = {
  "dashboard.settings_emi.get": { limits: { request: 16_384, response: 16_384 } },
  "dashboard.settings_emi.update": { revision: "required", limits: { request: 16_384, response: 16_384 } },
} satisfies Record<string, OperationRegistryEntry>;
