import { useQuery } from "@tanstack/react-query";
import { Store } from "lucide-react";
import { getApiV1AdminSettingsBusiness } from "@scalius/api-client/sdk";
import { cn } from "@scalius/shared/utils";
import { usePermissions } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { apiData } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { storefrontUrlQueryOptions } from "~/lib/api-query-options/storefront-url";

/**
 * The store's name (Business settings, for staff who may read them) and its
 * storefront host. An unnamed store has no name here: callers ask for one or
 * show the host, never "Scalius".
 */
export function useStoreIdentity() {
  const { hasPermission } = usePermissions();
  const canView = hasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_VIEW);
  const business = useQuery({
    queryKey: queryKeys.settings.business(),
    queryFn: () => apiData(getApiV1AdminSettingsBusiness()),
    enabled: canView,
  });
  const storefront = useQuery(storefrontUrlQueryOptions());
  const url = (storefront.data as { storefrontUrl?: string } | undefined)?.storefrontUrl ?? "";
  return {
    canView,
    loaded: Boolean(business.data),
    name: business.data?.companyName?.trim() ?? "",
    host: url.replace(/^https?:\/\//, "").replace(/\/$/, ""),
  };
}

/** Shopify's store avatar: a coloured square with the name's first character. */
export function StoreBadge({ name, className }: { name: string; className?: string }) {
  return (
    <span aria-hidden className={cn("grid size-5 shrink-0 place-items-center rounded-md bg-store-badge text-caption font-semibold text-store-badge-foreground", className)}>
      {/* The first character, whole (an emoji is never split). */}
      {name ? Array.from(name)[0]!.toUpperCase() : <Store className="size-3.5" />}
    </span>
  );
}
