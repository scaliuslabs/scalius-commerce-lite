// Agent operation registry rows for the dashboard home, analytics and search routes.
import type { OperationRegistryEntry } from "./entry";

export const DASHBOARD_HOME_OPERATIONS = {
  "dashboard.reports.list": { limits: { request: 16_384 } },
  "dashboard.reports.overview": { limits: { request: 16_384 } },
  "dashboard.reports.get": { limits: { request: 16_384 } },
  "dashboard.reports.export": {
    batch: "forbidden",
    artifact: {
      mediaTypes: ["text/csv"],
      disposition: "attachment",
      filenamePolicy: "content-disposition",
      maxArtifactBytes: 16 * 1024 * 1024,
      delivery: "authenticated-handle",
    },
  },
  "dashboard.home.activity": { limits: { request: 16_384, response: 32_768 } },
  "dashboard.home.summary": { limits: { request: 16_384 } },
  "dashboard.home.setup_guide": {
    exposure: "excluded",
    reason:
      "The setup guide is the signed-in staff member's own Home card; its dismissal is a personal preference, and the facts it shows are available through the settings, catalog and order operations.",
  },
  "dashboard.home.setup_guide_dismiss": {
    exposure: "excluded",
    reason: "Dismissing the setup guide is the signed-in staff member's own Home preference.",
  },
  "dashboard.home.setup_guide_show": {
    exposure: "excluded",
    reason: "Showing the setup guide again is the signed-in staff member's own Home preference.",
  },
  // The command palette's bounded, permission-filtered cross-resource find: an
  // agent resolves "order 1042" or "Rahim" in one read, then reads the record.
  "dashboard.search.global": { limits: { request: 16_384 } },
  // Store-wide launch steps (Home's guide without the staff dismissal).
  "dashboard.setup.checklist": { limits: { request: 16_384 } },
} satisfies Record<string, OperationRegistryEntry>;
