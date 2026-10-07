// src/modules/fraud-checker/provider.ts
// The fraud port as the order page's lookup calls it: one app fraud checker
// (`<plugin id>:<provider id>`) bound to the request, through the shared port
// (`@scalius/shared/plugins/providers/fraud`). Core has no checker of its own;
// the Bangladesh courier-history services are the Bangladesh pack's.
import type { BoundProvider } from "../../integrations/provider-port";

/** The fraud checker a lookup goes through. */
export type FraudProvider = BoundProvider<"fraud">;
