/**
 * Renders the WebP renditions of images that were uploaded without them
 * (agent and URL-import uploads) while a dashboard tab is open. Nothing draws:
 * the work starts in idle time well after the first page, only for staff who
 * may upload media, and its code is never part of a screen's first download.
 */
import { useEffect } from "react";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { usePermissions } from "~/contexts/PermissionContext";

export function PendingRenditionsLoader() {
  const { hasPermission } = usePermissions();
  const canUpload = hasPermission(PERMISSIONS.MEDIA_UPLOAD);
  useEffect(() => {
    if (!canUpload) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void import("./utils/pending-renditions-runner").then((module) => {
      if (!cancelled) stop = module.startPendingRenditions();
    }, () => undefined);
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [canUpload]);
  return null;
}
