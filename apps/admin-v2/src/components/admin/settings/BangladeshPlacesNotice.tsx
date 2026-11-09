// What a store delivering in Bangladesh still needs when its zone is set but
// buyers can't order: Bangladesh's City/Thana/Area places, which a buyer
// there picks at checkout (no thana, no address, no order: the storefront
// says "This store isn't delivering yet"). The one-click fix turns on the
// Bangladesh pack (it asks for nothing by itself) and its Bangladesh places
// feature, whose turning on loads the places, in one consent. Shown on the
// shipping zones card, in the zone editor and in Home's setup guide.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { MapPin } from "lucide-react";
import { toast } from "~/lib/toast";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { usePermissions } from "~/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { bangladeshPlacesMessages } from "~/i18n/settings-shipping";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { activateApp, enableAppFeature } from "~/lib/api-mutations/apps";
import { appQueryOptions, type AppDetail } from "~/lib/api-query-options/apps";
import { areaCountsQuery } from "~/lib/api-query-options/settings-screens";
import { BANGLADESH_PACK_ID } from "~/lib/bangladesh-pack";
import { queryKeys } from "~/lib/query-keys";
import { FeatureAccess, hasFeatureAccess } from "../apps/AppFeatures";

/** The pack's feature that loads Bangladesh's places when it is turned on. */
export const BANGLADESH_PLACES_FEATURE = "places";

/**
 * Whether buyers in Bangladesh can choose an address: some thana exists.
 * Null while unknown (no permission to read places, or still loading).
 */
export function useBangladeshPlacesMissing(): boolean | null {
  const { hasPermission } = usePermissions();
  const canView = hasPermission(ADMIN_PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_VIEW);
  const counts = useQuery({ ...areaCountsQuery, enabled: canView });
  if (!counts.data) return null;
  return counts.data.zones === 0;
}

/** Turns the pack on when it is off, then its places feature: one consent, the places load with it. */
async function loadBangladeshPlaces(app: AppDetail): Promise<{ app: AppDetail; hookError: string | null }> {
  let current = app;
  if (current.status !== "active") current = (await activateApp(current)).app;
  const feature = current.features.find((entry) => entry.id === BANGLADESH_PLACES_FEATURE);
  if (!feature) throw new Error("places feature missing");
  if (feature.enabled) return { app: current, hookError: null };
  const enabled = await enableAppFeature(current, feature);
  return { app: enabled.app, hookError: enabled.hookError ?? null };
}

export function BangladeshPlacesNotice({ className }: { className?: string }) {
  const t = useMessages(bangladeshPlacesMessages);
  const queryClient = useQueryClient();
  const { hasPermission, isSuperAdmin } = usePermissions();
  const canSeeApps = hasPermission(ADMIN_PERMISSIONS.APPS_VIEW);
  const canEditPlaces = hasPermission(ADMIN_PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_EDIT);
  const pack = useQuery({ ...appQueryOptions(BANGLADESH_PACK_ID), enabled: canSeeApps, retry: false });
  const [confirming, setConfirming] = useState(false);
  const places = pack.data?.features.find((feature) => feature.id === BANGLADESH_PLACES_FEATURE) ?? null;
  // Turned on already: the load is under way (the hourly job finishes what turning it on could not).
  const loading = pack.data?.status === "active" && places?.enabled === true;
  useQuery({ ...areaCountsQuery, enabled: loading, refetchInterval: loading ? 5_000 : false });
  const canLoad = isSuperAdmin && Boolean(pack.data?.runtimeAvailable) && places !== null && !loading;

  const load = useMutation({
    mutationFn: () => loadBangladeshPlaces(pack.data!),
    onSuccess: ({ app, hookError }) => {
      queryClient.setQueryData(queryKeys.apps.detail(app.id), app);
      void queryClient.invalidateQueries({ queryKey: queryKeys.apps.list() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.apps.surfaces() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings.deliveryLocations() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.setupGuide() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings.checkoutReadiness() });
      setConfirming(false);
      if (hookError) toast.warning(t("partly"), { description: hookError, duration: 10_000 });
      else toast.success(t("loaded"));
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apps.detail(BANGLADESH_PACK_ID) });
      toast.error(t("failed"));
    },
  });

  return (
    <Alert variant="warning" className={className} data-bangladesh-places-notice>
      <MapPin aria-hidden="true" />
      <AlertTitle>{t("title")}</AlertTitle>
      <AlertDescription>
        <p>{loading ? t("loading") : t("body")}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-2">
          {canLoad ? (
            <Button type="button" size="sm" onClick={() => setConfirming(true)}>{t("load")}</Button>
          ) : pack.data && !isSuperAdmin && !loading ? (
            <span>{t("askOwner")}</span>
          ) : null}
          {loading || (pack.data && !canLoad && isSuperAdmin) ? (
            <Link to="/admin/apps/$pluginId" params={{ pluginId: BANGLADESH_PACK_ID }} className="text-link hover:underline">{t("openPack")}</Link>
          ) : null}
          {canEditPlaces && !loading ? (
            <Link to="/admin/settings/shipping/areas" className="text-link hover:underline">{t("importOwn")}</Link>
          ) : null}
        </div>
      </AlertDescription>
      <Dialog open={confirming && Boolean(pack.data && places)} onOpenChange={(next) => (load.isPending ? undefined : setConfirming(next))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("dialogTitle")}</DialogTitle>
            <DialogDescription>{t("dialogBody")}</DialogDescription>
          </DialogHeader>
          {pack.data && pack.data.status !== "active" ? <p className="text-body text-muted-foreground">{t("dialogActivate")}</p> : null}
          {places && hasFeatureAccess(places) ? <FeatureAccess feature={places} /> : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={load.isPending} onClick={() => setConfirming(false)}>{t("cancel")}</Button>
            <Button type="button" loading={load.isPending} onClick={() => load.mutate()}>{t("confirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Alert>
  );
}
