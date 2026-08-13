import { createAdminApiFunction as createServerFn } from "../admin-api-function";
import { apiGet } from "../api";
import type { SeoDiscoveryLiveProbeResult } from "./seo-discovery-live-probe";

export const getSeoDiscoveryLiveProbe = createServerFn({
  method: "GET",
}).handler(async () =>
  apiGet<SeoDiscoveryLiveProbeResult>("/settings/seo/live-probe"),
);
