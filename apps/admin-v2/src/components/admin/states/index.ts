/**
 * The dashboard's one family of state views (polish bar E1–E3, L1–L3,
 * R1–R6). Every screen draws empty, failed, missing, forbidden, offline,
 * read-only and loading states from here; see "States" in DESIGN.md.
 */
export { EmptyState, FilteredEmptyState, SectionEmpty } from "./EmptyState";
export { ErrorState, type ErrorStateProps } from "./ErrorState";
export { NoPermissionState, PageNotFound, RecordNotFound } from "./NotFound";
export { ReadOnlyNotice } from "./ReadOnlyNotice";
export { OfflineBanner } from "./OfflineBanner";
export { BootSpinner, PageSkeleton, type PageSkeletonKind } from "./PageSkeleton";
export { classifyFailure, isOnline, retriesWhenOnline, type FailureKind } from "./failure";
export { useOnlineStatus, useRetryWhenOnline } from "./online-status";
export { recordResource, type RecordNoun, type RecordResource } from "./record-resource";
