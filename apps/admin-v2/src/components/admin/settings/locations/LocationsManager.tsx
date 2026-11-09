// Settings › Locations (commerce hook H1): where stock is held. The list with
// each location's stock; add, edit, make default, archive and unarchive.
// Archiving is refused while a location holds stock or open orders ship from
// it; the default can't be archived.
import { seededName } from "~/lib/seeded-names";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import { toast } from "~/lib/toast";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { StatusBadge } from "~/components/admin/resource/StatusBadge";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";
import { Label } from "~/components/ui/label";
import { useCatalogActionPermissions } from "~/hooks/use-catalog-action-permissions";
import { dashboardNumberLocale, useMessages } from "~/i18n";
import { settingsLocationsMessages } from "~/i18n/settings-locations";
import { getServerFnError } from "~/lib/api-helpers";
import { readAdminApiError } from "~/lib/admin-api-error";
import { salesChannelName } from "~/lib/api-query-options/sales-channels";
import { countryName } from "~/lib/country-name";
import { formatList } from "@scalius/shared/locale-words";
import {
  inventoryLocationsQueryOptions,
  useInventoryLocationAction,
  type InventoryLocation,
} from "~/lib/api-query-options/inventory-locations";
import { SettingsCard, SettingsCardLoading } from "../SettingsPage";
import { SettingsLoadFailure } from "../SettingsLoadFailure";
import { LocationDialog } from "./LocationDialog";

/**
 * The channels an archive was refused for: the location is the only active
 * one they sell from (INV-011). Their names, or null for another refusal.
 */
export function channelsSellingOnly(error: unknown): string[] | null {
  const details = readAdminApiError(error)?.details as { reason?: unknown; channels?: unknown } | undefined;
  if (details?.reason !== "location_sells_channel" || !Array.isArray(details.channels)) return null;
  const names = (details.channels as Array<{ id?: unknown; name?: unknown } | null>).flatMap((channel) =>
    typeof channel?.id === "string" && typeof channel.name === "string" ? [salesChannelName({ id: channel.id, name: channel.name })] : []);
  return names.length > 0 ? names : null;
}

function addressLine(location: InventoryLocation): string {
  // The country is the location's authority (tax origin): always shown, even without an address.
  return [location.addressLine1, location.addressLine2, location.city, location.postalCode, countryName(location.countryCode)]
    .filter(Boolean)
    .join(", ");
}

export function LocationsManager() {
  const t = useMessages(settingsLocationsMessages);
  // Inventory staff or store settings editors (the API's location write rule).
  const { inventory: { canManageLocations: canEdit } } = useCatalogActionPermissions();
  const [showArchived, setShowArchived] = useState(false);
  const { data, isError, refetch } = useQuery(inventoryLocationsQueryOptions(showArchived));
  const [editing, setEditing] = useState<{ location: InventoryLocation | null } | null>(null);
  const [archiving, setArchiving] = useState<InventoryLocation | null>(null);
  const action = useInventoryLocationAction();

  const run = (location: InventoryLocation, kind: "archive" | "unarchive" | "default") =>
    action.mutate({ id: location.id, action: kind }, {
      onSuccess: () => {
        toast.success(t(kind === "archive" ? "archivedToast" : kind === "unarchive" ? "unarchivedToast" : "defaultToast"));
        setArchiving(null);
      },
      // Archive refusals name what still holds the location (stock, open orders, a channel's only location).
      onError: (error) => {
        const channels = channelsSellingOnly(error);
        void toast.error(channels
          ? t("archiveSellsChannels", { channels: formatList(channels, dashboardNumberLocale()), count: channels.length, name: seededName(location) })
          : getServerFnError(error, t("actionFailed")));
      },
    });

  if (isError) return <SettingsLoadFailure title={t("loadFailed")} onRetry={refetch} />;
  if (!data) return <SettingsCardLoading />;

  return (
    <>
      <SettingsCard
        id="inventoryLocations"
        title={t("title")}
        description={t("description")}
        action={canEdit ? <Button type="button" size="sm" onClick={() => setEditing({ location: null })}>{t("add")}</Button> : null}
        rows={
          <>
            <ul>
              {data.map((location) => (
                <li key={location.id} className="flex items-start gap-3 border-b border-border px-4 py-3">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="break-words text-body font-medium">{seededName(location)}</span>
                      <code className="text-muted-foreground">{location.code}</code>
                      {location.isDefault ? <Badge variant="info">{t("default")}</Badge> : null}
                      {location.status === "archived" ? <StatusBadge status="archived">{t("archived")}</StatusBadge> : null}
                    </p>
                    {addressLine(location) ? <p className="break-words text-body">{addressLine(location)}</p> : null}
                    <p className="text-body text-muted-foreground tabular-nums">
                      {t(`kind.${location.kind}`)} · {location.onHand > 0
                        ? t("stock", { units: location.onHand, skus: location.stockedSkus })
                        : t("noStock")}
                    </p>
                  </div>
                  {canEdit ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button type="button" variant="ghost" size="icon" aria-label={t("actionsFor", { name: seededName(location) })}>
                          <MoreHorizontal aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {location.status === "archived" ? (
                          <DropdownMenuItem onSelect={() => run(location, "unarchive")}>{t("unarchive")}</DropdownMenuItem>
                        ) : (
                          <>
                            <DropdownMenuItem onSelect={() => setEditing({ location })}>{t("edit")}</DropdownMenuItem>
                            {location.isDefault ? null : (
                              <>
                                <DropdownMenuItem onSelect={() => run(location, "default")}>{t("makeDefault")}</DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => setArchiving(location)}>{t("archive")}</DropdownMenuItem>
                              </>
                            )}
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-2 px-4 py-3">
              <Checkbox id="inventory-locations-show-archived" checked={showArchived} onCheckedChange={(value) => setShowArchived(value === true)} />
              <Label htmlFor="inventory-locations-show-archived">{t("showArchived")}</Label>
            </div>
          </>
        }
      />
      <LocationDialog
        location={editing?.location ?? null}
        open={editing !== null}
        onOpenChange={(open) => (open ? undefined : setEditing(null))}
      />
      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => (open ? undefined : setArchiving(null))}
        title={t("archiveTitle", { name: (archiving ? seededName(archiving) : "") })}
        description={t("archiveBody")}
        confirmLabel={t("archive")}
        isLoading={action.isPending}
        onConfirm={() => (archiving ? run(archiving, "archive") : undefined)}
      />
    </>
  );
}
