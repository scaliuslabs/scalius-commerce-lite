import { createServerFn } from "@tanstack/react-start";

import { apiGet } from "../api.server";
import {
  runSeoDiscoveryLiveProbe,
  type StorefrontUrlPayload,
} from "./seo-discovery-live-probe";

export const getSeoDiscoveryLiveProbe = createServerFn({
  method: "GET",
}).handler(async () =>
  runSeoDiscoveryLiveProbe({
    getStorefrontUrl: () =>
      apiGet<StorefrontUrlPayload>("/settings/storefront-url"),
  }),
);
