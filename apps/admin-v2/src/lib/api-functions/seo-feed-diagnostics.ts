import { createAdminApiFunction as createServerFn } from "../admin-api-function";
import type { ProductFeedDiagnosticsReport } from "@scalius/core/modules/products";
import { apiGet } from "../api";

export type SeoFeedDiagnosticsResult = ProductFeedDiagnosticsReport;

export const getSeoFeedDiagnostics = createServerFn({
  method: "GET",
}).handler(async () =>
  apiGet<SeoFeedDiagnosticsResult>("/settings/seo/feed-diagnostics"),
);
