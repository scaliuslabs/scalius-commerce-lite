import { createApplyRuntime } from "../apply-runtime.mjs";

// The lifecycle and staged executor share one desired-state authority. Keeping
// a second partial resolver here previously meant the publication lifecycle
// could verify categories but not products, collections, heroes, or Brand.
export function createDemoLifecycleRuntime(readClient) {
  return createApplyRuntime(readClient);
}
