import { lazy, Suspense } from "react";
import type { RelatedObjectRecord } from "@scalius/shared/plugins/objects";
import { usePermissions } from "~/contexts/PermissionContext";

const RelatedObjectsCardContent = lazy(() => import("./RelatedObjectsCardContent").then((module) => ({ default: module.RelatedObjectsCardContent })));

/** Load the optional card and its copy only when this resource has related records. */
export function RelatedObjectsCard({ records }: { records?: readonly RelatedObjectRecord[] }) {
  const { hasPermission } = usePermissions();
  if (!hasPermission("objects.view") || !records?.length) return null;
  return <Suspense fallback={null}><RelatedObjectsCardContent records={records} /></Suspense>;
}
