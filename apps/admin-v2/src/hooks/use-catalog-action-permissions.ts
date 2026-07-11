import { useMemo } from "react";
import { usePermissions } from "~/contexts/PermissionContext";
import { getCatalogActionPermissions } from "~/lib/catalog-action-permissions";

export function useCatalogActionPermissions() {
  const { hasPermission } = usePermissions();

  return useMemo(
    () => getCatalogActionPermissions(hasPermission),
    [hasPermission],
  );
}
