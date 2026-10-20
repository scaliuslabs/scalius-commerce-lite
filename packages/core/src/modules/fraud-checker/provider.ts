// src/modules/fraud-checker/provider.ts
// The courier-history port as the order page's fraud check calls it: one app
// checker (`<plugin id>:<provider id>`) bound to the request, through the
// shared port (`@scalius/shared/plugins/providers/courier-history`). Core has
// no checker of its own; the Bangladesh courier-history services are the
// Bangladesh pack's.
import type { BoundProvider } from "../../integrations/provider-port";

/** The courier-history checker a fraud check goes through. */
export type FraudProvider = BoundProvider<"courier_history">;
