// Settings › Sales channels (docs/MARKETS-DESIGN.md D6), Shopify's "Apps and
// sales channels": the online store, Google, Facebook and Instagram, AI
// agents and each app's channel, with its status and the products published
// to it. Manage opens one channel: switch it on or off (not the online store;
// an app's follows the app) and, in a store with more than one location,
// choose the locations whose stock it sells.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "~/lib/toast";
import { StatusBadge } from "~/components/admin/resource/StatusBadge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Switch } from "~/components/ui/switch";
import { useHasPermission } from "~/contexts/PermissionContext";
import { formatNumber, translate, useMessages } from "~/i18n";
import { salesChannelsMessages, type SalesChannelsMessageKey } from "~/i18n/sales-channels";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { getServerFnError } from "~/lib/api-helpers";
import { inventoryLocationsQueryOptions, type InventoryLocation } from "~/lib/api-query-options/inventory-locations";
import {
  salesChannelName,
  salesChannelsQueryOptions,
  useUpdateSalesChannel,
  type SalesChannel,
} from "~/lib/api-query-options/sales-channels";
import { SettingsCard, SettingsCardLoading } from "../SettingsPage";
import { SettingsLoadFailure } from "../SettingsLoadFailure";

const ONLINE_STORE = "sc_online_store";

/** One line about a channel: what it is, or the app that added it. */
function salesChannelAbout(channel: Pick<SalesChannel, "id" | "pluginId">): string {
  const key = `about.${channel.id}` as SalesChannelsMessageKey;
  if (key in salesChannelsMessages.en) return translate(salesChannelsMessages, key);
  return translate(salesChannelsMessages, "about.app", { app: channel.pluginId ?? "" });
}

export function SalesChannelsSettings() {
  const t = useMessages(salesChannelsMessages);
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  const channels = useQuery(salesChannelsQueryOptions());
  // Archived locations too: a channel may still name one.
  const locations = useQuery(inventoryLocationsQueryOptions(true));
  const [managing, setManaging] = useState<SalesChannel | null>(null);

  if (channels.isError) return <SettingsLoadFailure title={t("loadFailed")} onRetry={channels.refetch} />;
  if (!channels.data) return <SettingsCardLoading />;
  const allLocations = locations.data ?? [];
  const activeLocations = allLocations.filter((location) => location.status === "active");

  // One location means no choice to make: the locations stay out of sight.
  const choosesLocations = activeLocations.length > 1;
  const locationSummary = (channel: SalesChannel) => {
    if (!locations.data || !choosesLocations) return null;
    const linked = activeLocations.filter((location) => channel.locationIds.includes(location.id)).length;
    return linked === activeLocations.length
      ? t("allLocations")
      : t("someLocations", { count: linked, total: formatNumber(activeLocations.length) });
  };

  return (
    <>
      <SettingsCard
        id="salesChannels"
        title={t("title")}
        description={t("description")}
        rows={
          <ul>
            {channels.data.map((channel) => (
              <li key={channel.id} className="flex flex-wrap items-start gap-3 border-b border-border px-4 py-3 last:border-b-0">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="break-words text-body font-medium">{salesChannelName(channel)}</span>
                    <StatusBadge status={channel.status === "active" ? "active" : "inactive"}>
                      {channel.status === "active" ? t("on") : t("off")}
                    </StatusBadge>
                  </p>
                  <p className="break-words text-body text-muted-foreground">{salesChannelAbout(channel)}</p>
                  <p className="text-body text-muted-foreground tabular-nums">
                    <Link
                      to="/admin/products"
                      search={{ channel: channel.id } as never}
                      className="text-foreground hover:underline"
                    >
                      {t("products", { count: channel.publishedProducts })}
                    </Link>
                    {locationSummary(channel) ? <> · {locationSummary(channel)}</> : null}
                  </p>
                </div>
                {canEdit && (choosesLocations || channel.id !== ONLINE_STORE) ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => setManaging(channel)}>
                    {t("manage")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        }
      />
      {managing ? (
        <ManageChannelDialog
          key={managing.id}
          channel={managing}
          locations={allLocations}
          choosesLocations={choosesLocations}
          onClose={() => setManaging(null)}
        />
      ) : null}
    </>
  );
}

function ManageChannelDialog({ channel, locations, choosesLocations, onClose }: {
  channel: SalesChannel;
  locations: InventoryLocation[];
  choosesLocations: boolean;
  onClose: () => void;
}) {
  const t = useMessages(salesChannelsMessages);
  const update = useUpdateSalesChannel();
  const [active, setActive] = useState(channel.status === "active");
  const [locationIds, setLocationIds] = useState<string[]>(channel.locationIds);
  const [error, setError] = useState<string | null>(null);
  const statusLocked = channel.id === ONLINE_STORE
    ? t("statusLockedStore")
    : channel.kind === "app" ? t("statusLockedApp") : null;
  // Archived locations show only while the channel still names one.
  const shown = locations.filter((location) => location.status === "active" || channel.locationIds.includes(location.id));
  const name = salesChannelName(channel);

  const save = () => {
    if (choosesLocations && !locationIds.some((id) => shown.find((location) => location.id === id)?.status === "active")) {
      setError(t("locationsRequired"));
      return;
    }
    const statusChanged = (channel.status === "active") !== active;
    const sameLocations = [...locationIds].sort().join() === [...channel.locationIds].sort().join();
    if (!statusChanged && sameLocations) {
      onClose();
      return;
    }
    update.mutate({
      id: channel.id,
      body: {
        ...(statusChanged && !statusLocked ? { status: active ? "active" as const : "inactive" as const } : {}),
        ...(sameLocations ? {} : { locationIds }),
      },
    }, {
      onSuccess: () => {
        toast.success(t("saved"));
        onClose();
      },
      onError: (failure) => setError(getServerFnError(failure, t("saveFailed"))),
    });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !update.isPending) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("manageTitle", { name })}</DialogTitle>
          <DialogDescription>{salesChannelAbout(channel)}</DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <section className="space-y-2">
            <h3 className="text-body font-medium">{t("status")}</h3>
            <label className="flex items-start gap-3 text-body">
              <Switch
                checked={active}
                disabled={statusLocked !== null || update.isPending}
                onCheckedChange={setActive}
              />
              <span>
                {t("statusOn")}
                <span className="block text-muted-foreground">{statusLocked ?? t("statusOnHelp")}</span>
              </span>
            </label>
          </section>
          {choosesLocations ? (
          <section className="space-y-2">
            <h3 className="text-body font-medium">{t("locations")}</h3>
            <p className="text-body text-muted-foreground">{t("locationsHelp")}</p>
            {shown.length === 0 ? <p className="text-body text-muted-foreground">{t("noLocations")}</p> : (
              <ul className="space-y-2">
                {shown.map((location) => (
                  <li key={location.id}>
                    <label className="flex items-start gap-3 text-body">
                      <Checkbox
                        checked={locationIds.includes(location.id)}
                        disabled={update.isPending}
                        onCheckedChange={(checked) => {
                          setError(null);
                          setLocationIds((current) => checked === true
                            ? [...new Set([...current, location.id])]
                            : current.filter((entry) => entry !== location.id));
                        }}
                        className="mt-0.5"
                      />
                      <span className="min-w-0 break-words">
                        {location.name}
                        {location.status === "archived" ? <span className="text-muted-foreground"> · {t("locationArchived")}</span> : null}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {error ? <p role="alert" className="text-body text-destructive">{error}</p> : null}
          </section>
          ) : error ? <p role="alert" className="text-body text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={update.isPending} onClick={onClose}>{t("cancel")}</Button>
          <Button type="button" loading={update.isPending} onClick={save}>{t("save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
