import { RefreshCw } from "lucide-react";

import { ADMIN_PERMISSIONS } from "@/lib/admin-permissions";
import { useClearCache } from "@/lib/api-mutations/cache";
import { useHasPermission } from "@/contexts/PermissionContext";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";

export function CacheManager() {
  const canRefresh = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_CACHE_MANAGE);
  const refresh = useClearCache();

  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-base">Refresh store</CardTitle>
        <CardDescription>
          Your store updates automatically when you save. Refresh only after
          changing store data outside the dashboard.
        </CardDescription>
      </CardHeader>
      {canRefresh && (
        <CardContent>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 gap-1.5 sm:min-h-9"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
          >
            <RefreshCw className={`h-4 w-4 ${refresh.isPending ? "animate-spin" : ""}`} />
            Refresh store
          </Button>
        </CardContent>
      )}
    </Card>
  );
}
