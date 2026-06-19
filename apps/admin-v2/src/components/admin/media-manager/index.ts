// Keep this picker barrel narrow. The standalone media page imports
// MediaManagerPage directly so picker call sites do not preload it.

export { MediaManager } from "./LazyMediaManager";

// Export types for consumers
export type { MediaFile, MediaManagerProps } from "./types";
