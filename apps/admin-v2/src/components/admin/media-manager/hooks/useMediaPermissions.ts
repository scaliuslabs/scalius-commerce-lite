import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { usePermissions } from "~/contexts/PermissionContext";

/** Mirrors the media route permissions; browsing and picker selection stay independent. */
export function useMediaPermissions() {
  const { hasPermission } = usePermissions();
  const upload = hasPermission(PERMISSIONS.MEDIA_UPLOAD);
  return {
    upload,
    update: upload,
    delete: hasPermission(PERMISSIONS.MEDIA_DELETE),
    folders: hasPermission(PERMISSIONS.MEDIA_MANAGE_FOLDERS),
  };
}
