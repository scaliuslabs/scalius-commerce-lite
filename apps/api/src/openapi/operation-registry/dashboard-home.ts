// Agent operation registry rows for the dashboard home and search routes.
import type { OperationRegistryEntry } from "./entry";

export const DASHBOARD_HOME_OPERATIONS = {
  "dashboard.home.activity": { limits: { request: 16_384, response: 32_768 } },
  "dashboard.home.summary": { limits: { request: 16_384 } },
  "dashboard.search_reindex.reindex": {
    exposure: "excluded",
    reason:
      "Placeholder returns ‘Reindex initiated’ without scheduling or performing reindex work; execution would report a false side effect.",
  },
  "dashboard.search.get_search": {
    exposure: "excluded",
    reason:
      "Legacy cross-resource search is unused by the dashboard; authoritative bounded product, category, and page list operations provide merchant search and filtering.",
  },
} satisfies Record<string, OperationRegistryEntry>;
