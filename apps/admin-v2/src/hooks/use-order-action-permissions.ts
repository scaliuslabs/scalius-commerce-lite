import { useMemo } from "react";
import { usePermissions } from "@/contexts/PermissionContext";
import { getOrderActionPermissions } from "@/lib/order-action-permissions";

export function useOrderActionPermissions() {
  const { hasPermission } = usePermissions();

  return useMemo(
    () => getOrderActionPermissions(hasPermission),
    [hasPermission],
  );
}
