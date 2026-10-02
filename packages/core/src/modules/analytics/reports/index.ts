// Analytics overview and reports (see ../README.md "Analytics and reports").
export { createAnalyticsContext, probeOrderLineUnitCost, type AnalyticsContext } from "./context";
export {
  getAnalyticsOverview,
  type AnalyticsOverview,
  type OverviewBreakdownRow,
  type OverviewPeriod,
  type OverviewSeriesPoint,
  type SalesMeasures,
} from "./overview";
export { type ReportCell, type ReportPage, type ReportRow, type ReportSort } from "./engine";
export {
  exportAnalyticsReportCsv,
  getAnalyticsOverviewForRequest,
  getAnalyticsReportPage,
  listAnalyticsReports,
  resolveAnalyticsRange,
  type AnalyticsAccess,
  type ReportCatalogEntry,
  type ReportCsvExport,
  type ReportUnavailableReason,
} from "./service";
export { REPORT_CSV_MAX_BYTES } from "./csv";
