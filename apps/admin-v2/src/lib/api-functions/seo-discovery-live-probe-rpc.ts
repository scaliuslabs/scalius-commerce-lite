import { createServerFn } from "@tanstack/react-start";

import { apiGet } from "../api.server";
import type { SeoSettingsPayload } from "./settings";
import {
  runSeoDiscoveryLiveProbe,
  type StorefrontUrlPayload,
} from "./seo-discovery-live-probe";

export const getSeoDiscoveryLiveProbe = createServerFn({
  method: "GET",
}).handler(async () =>
  runSeoDiscoveryLiveProbe({
    getDiscoveryPolicy: () => apiGet<SeoSettingsPayload>("/settings/seo"),
    getStorefrontUrl: () =>
      apiGet<StorefrontUrlPayload>("/settings/storefront-url"),
  }),
);
