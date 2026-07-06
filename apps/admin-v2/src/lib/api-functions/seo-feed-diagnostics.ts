import { createServerFn } from "@tanstack/react-start";
import type { ProductFeedDiagnosticsReport } from "@scalius/core/modules/products";

export type SeoFeedDiagnosticsResult = ProductFeedDiagnosticsReport;

async function readSeoFeedDiagnostics(): Promise<SeoFeedDiagnosticsResult> {
  const { apiGet } = await import("../api.server");
  return apiGet<SeoFeedDiagnosticsResult>("/settings/seo/feed-diagnostics");
}

export const getSeoFeedDiagnostics = createServerFn({
  method: "GET",
}).handler(async () => readSeoFeedDiagnostics());
