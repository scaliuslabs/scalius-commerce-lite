import { createServerFn } from "@tanstack/react-start";
import type { ProductFeedDiagnosticsReport } from "@scalius/core/modules/products";
import { apiGet } from "../api.server";

export type SeoFeedDiagnosticsResult = ProductFeedDiagnosticsReport;

export const getSeoFeedDiagnostics = createServerFn({
  method: "GET",
}).handler(async () =>
  apiGet<SeoFeedDiagnosticsResult>("/settings/seo/feed-diagnostics"),
);
