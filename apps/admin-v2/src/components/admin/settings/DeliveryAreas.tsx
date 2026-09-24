import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, MoreHorizontal, Search } from "lucide-react";
import { toast } from "sonner";
import {
  deleteApiV1AdminSettingsDeliveryLocations,
  deleteApiV1AdminSettingsDeliveryLocationsAll,
  deleteApiV1AdminSettingsDeliveryLocationsById,
  deleteApiV1AdminSettingsDeliveryLocationsImportPathao,
  postApiV1AdminSettingsDeliveryLocations,
  postApiV1AdminSettingsDeliveryLocationsImportPathao,
  putApiV1AdminSettingsDeliveryLocationsById,
} from "@scalius/api-client/sdk";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { Progress } from "~/components/ui/progress";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Switch } from "~/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { useHasPermission } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { apiData } from "~/lib/api";
import {
  deliveryLocationLoader,
  deliveryLocationsQueryOptions,
  deliveryProvidersQueryOptions,
  importPathaoStatusQueryOptions,
  type DeliveryLocation,
  type PathaoImportProgress,
} from "~/lib/api-query-options/delivery";
import { areaCountsQuery } from "~/lib/api-query-options/settings-screens";
import { queryKeys } from "~/lib/query-keys";
import { formatNumber, useMessages } from "~/i18n";
import { toLatinDigits } from "@scalius/shared/phone-input";
import { settingsMessages } from "~/i18n/settings";
import { shippingMessages } from "~/i18n/settings-shipping";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { useSaveBar } from "../shared/SaveBar";
import { SettingsCard, SettingsDialog, SettingsField } from "./SettingsPage";

type Level = "city" | "zone" | "area";
const PARENT: Record<Exclude<Level, "city">, Level> = { zone: "city", area: "zone" };
const PAGE_SIZE = 20;

type Descendants = { zones: number; areas: number };
const descendantsOf = (location: DeliveryLocation): Descendants => location.descendants ?? { zones: 0, areas: 0 };

/** "1 thana and 3 areas", or null when nothing is under the places being deleted. */
function usePlacesUnder() {
  const t = useMessages(shippingMessages);
  return ({ zones, areas }: Descendants): string | null => {
    const parts = [
      zones ? (zones === 1 ? t("oneThana") : t("thanaCount", { count: zones })) : null,
      areas ? (areas === 1 ? t("oneArea") : t("areaCount", { count: areas })) : null,
    ].filter((part): part is string => part !== null);
    return parts.length === 2 ? t("both", { first: parts[0]!, second: parts[1]! }) : parts[0] ?? null;
  };
}

function useRefreshAreas() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      [
        queryKeys.settings.deliveryLocations(),
        queryKeys.settings.deliveryLocationsAll(),
        queryKeys.settings.checkoutReadiness(),
        queryKeys.settings.shippingMethods(),
      ].map(
        (queryKey) => queryClient.invalidateQueries({ queryKey }),
      ),
    );
}

function LocationForm({ level, location }: { level: Level; location: DeliveryLocation | null }) {
  const t = useMessages(shippingMessages);
  const common = useMessages(settingsMessages);
  const refresh = useRefreshAreas();
  const placesUnder = usePlacesUnder();
  const [saved] = useState(() => ({
    name: location?.name ?? "",
    parentId: location?.parentId ?? "",
    isActive: location?.isActive ?? true,
  }));
  const [draft, setDraft] = useState(saved);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const under = location ? placesUnder(descendantsOf(location)) : null;
  const save = useMutation({
    mutationFn: (): Promise<unknown> => {
      // Courier ids (externalIds) come from the Pathao import, matched by name.
      const externalIds = (location?.externalIds ?? {}) as Record<string, string | number>;
      const body = {
        name: draft.name.trim(),
        type: level,
        parentId: level === "city" ? null : draft.parentId || null,
        externalIds,
        metadata: (location?.metadata ?? {}) as Record<string, string>,
        isActive: draft.isActive,
      };
      return location
        ? apiData(putApiV1AdminSettingsDeliveryLocationsById({ path: { id: location.id }, body }))
        : apiData(postApiV1AdminSettingsDeliveryLocations({ body }));
    },
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => apiData(deleteApiV1AdminSettingsDeliveryLocationsById({ path: { id: location!.id } })),
    onSuccess: async () => {
      toast.success(t("deleted"));
      await refresh();
    },
    onError: () => toast.error(common("saveFailed")),
  });
  useSaveBar({
    fields: { name: "location-name", parentId: "location-parent" },
    dirty: JSON.stringify(draft) !== JSON.stringify(saved),
    saving: save.isPending,
    invalid: !draft.name.trim() || (level !== "city" && !draft.parentId),
    save: () => save.mutateAsync(),
    discard: () => setDraft(saved),
  });
  return (
    <>
      <SettingsField id="location-name" label={t(level)} error={draft.name ? null : t("nameRequired")}>
        <Input id="location-name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
      </SettingsField>
      {level !== "city" ? (
        <SettingsField id="location-parent" label={t("parent")} error={draft.parentId ? null : t("parentRequired")}>
          <SearchableSelect
            id="location-parent"
            value={draft.parentId}
            selectedLabel={draft.parentId === location?.parentId ? location?.parentPath?.[0] : undefined}
            triggerClassName="w-full"
            load={deliveryLocationLoader({ type: PARENT[level], includeInactive: true })}
            queryKey={[...queryKeys.settings.deliveryLocations(), "picker", PARENT[level], null, true]}
            placeholder={t(PARENT[level])}
            searchPlaceholder={t("search")}
            emptyMessage={t("empty")}
            onValueChange={(parentId) => setDraft({ ...draft, parentId })}
          />
        </SettingsField>
      ) : null}
      <label className="flex min-h-11 items-center justify-between gap-4 text-body font-medium">
        {t("active")}
        <Switch checked={draft.isActive} onCheckedChange={(isActive) => setDraft({ ...draft, isActive })} />
      </label>
      {location ? (
        <>
          <Button type="button" variant="ghost" className="self-start" onClick={() => setConfirmDelete(true)}>
            {t("deleteLocation")}
          </Button>
          <ConfirmDialog
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title={common("deleteNamed", { name: location.name })}
            description={under ? t("deleteWithChildren", { name: location.name, places: under }) : t("deleteLocationConfirm")}
            confirmLabel={common("delete")}
            cancelLabel={common("cancel")}
            isLoading={remove.isPending}
            onConfirm={() => remove.mutate()}
          />
        </>
      ) : null}
    </>
  );
}

/** Pathao import runs in steps; the loop resumes an import left running. */
function usePathaoImport() {
  const refresh = useRefreshAreas();
  const t = useMessages(shippingMessages);
  const status = useQuery({ ...importPathaoStatusQueryOptions(), retry: false });
  const [progress, setProgress] = useState<PathaoImportProgress | null>(null);
  const [running, setRunning] = useState(false);
  const stopped = useRef(false);
  const resumed = useRef(false);

  async function run() {
    stopped.current = false;
    setRunning(true);
    try {
      while (!stopped.current) {
        const next = await apiData(postApiV1AdminSettingsDeliveryLocationsImportPathao());
        setProgress(next);
        if (next.status === "complete") {
          toast.success(t("importDone"));
          await refresh();
          break;
        }
        if (next.status === "error") throw new Error("import failed");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } catch {
      toast.error(t("importFailed"));
      setProgress((current) => (current ? { ...current, status: "error" } : current));
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    if (status.data?.status === "importing" && !resumed.current) {
      resumed.current = true;
      setProgress(status.data);
      void run();
    }
    return () => {
      stopped.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.data]);

  async function restart() {
    await apiData(deleteApiV1AdminSettingsDeliveryLocationsImportPathao()).catch(() => undefined);
    setProgress(null);
    await run();
  }

  return { progress, running, start: run, restart };
}

export function DeliveryAreasManager() {
  const t = useMessages(shippingMessages);
  const common = useMessages(settingsMessages);
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_EDIT);
  const refresh = useRefreshAreas();
  const placesUnder = usePlacesUnder();
  const [level, setLevel] = useState<Level>("city");
  const [search, setSearch] = useState("");
  const [parentFilter, setParentFilter] = useState("");
  const [parentFilterLabel, setParentFilterLabel] = useState<string | undefined>();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<"selected" | "import" | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const counts = useQuery(areaCountsQuery).data;
  const placeTotal = counts ? counts.cities + counts.zones + counts.areas : 0;
  const noPlaces = counts !== undefined && placeTotal === 0;
  const importer = usePathaoImport();

  const list = useQuery({
    ...deliveryLocationsQueryOptions({
      type: level,
      page,
      limit: PAGE_SIZE,
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(level !== "city" && parentFilter ? { parentId: parentFilter } : {}),
    }),
    placeholderData: (previous) => previous,
  });
  const couriers = useQuery(deliveryProvidersQueryOptions());
  const hasPathao = (couriers.data ?? []).some((courier) => courier.type === "pathao" && courier.isActive);
  const locations = list.data?.locations ?? [];
  const selectedUnder = placesUnder(
    locations
      .filter((location) => selected.includes(location.id))
      .map(descendantsOf)
      .reduce((sum, next) => ({ zones: sum.zones + next.zones, areas: sum.areas + next.areas }), { zones: 0, areas: 0 }),
  );
  // One place is named, like its own Delete; several are counted.
  const onlySelected = selected.length === 1 ? locations.find((location) => location.id === selected[0]) : undefined;
  const total = list.data?.pagination.total ?? 0;
  const totalPages = list.data?.pagination.totalPages ?? 1;

  const toggleActive = useMutation({
    mutationFn: (location: DeliveryLocation) =>
      apiData(putApiV1AdminSettingsDeliveryLocationsById({ path: { id: location.id }, body: { isActive: !location.isActive } })),
    onSuccess: refresh,
    onError: () => toast.error(common("saveFailed")),
  });
  const bulk = useMutation({
    mutationFn: (kind: "selected" | "all") =>
      kind === "all"
        ? apiData(deleteApiV1AdminSettingsDeliveryLocationsAll({ body: { confirmDeleteAll: true } }))
        : apiData(deleteApiV1AdminSettingsDeliveryLocations({ body: { ids: selected } })),
    onSuccess: async () => {
      toast.success(t("deleted"));
      setSelected([]);
      setConfirm(null);
      setConfirmAll(false);
      await refresh();
    },
    onError: () => toast.error(common("saveFailed")),
  });

  const changeLevel = (next: Level) => {
    setLevel(next);
    setSearch("");
    setParentFilter("");
    setParentFilterLabel(undefined);
    setPage(1);
    setSelected([]);
  };
  // Selection is per page, so the delete confirmation can count what's under it.
  const changePage = (next: number) => {
    setPage(next);
    setSelected([]);
  };
  const progress = importer.progress;

  return (
    <>
      {progress ? (
        <SettingsCard
          title={importer.running ? t("importing") : progress.status === "error" ? t("importFailed") : t("importDone")}
          action={
            progress.status === "error" ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void importer.restart()}>{t("retry")}</Button>
            ) : null
          }
        >
          {importer.running ? (
            <>
              <p className="text-body text-muted-foreground">{progress.progress.label}</p>
              <Progress value={progress.progress.total ? (progress.progress.current / progress.progress.total) * 100 : 0} />
            </>
          ) : null}
        </SettingsCard>
      ) : null}
      <SettingsCard
        header={
          <Tabs value={level} onValueChange={(value) => changeLevel(value as Level)} className="mr-auto">
            <TabsList>
              <TabsTrigger value="city">{t("cities")}</TabsTrigger>
              <TabsTrigger value="zone">{t("zones")}</TabsTrigger>
              <TabsTrigger value="area">{t("areas")}</TabsTrigger>
            </TabsList>
          </Tabs>
        }
        action={
          <div className="flex gap-2">
            {canEdit && hasPathao ? (
              <Button type="button" variant="outline" size="sm" loading={importer.running} onClick={() => setConfirm("import")}>
                {t("importBangladesh")}
              </Button>
            ) : null}
            {canEdit ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" size="icon" aria-label={t("moreActions")}>
                    <MoreHorizontal aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem disabled={placeTotal === 0} onSelect={() => setConfirmAll(true)}>{t("deleteAll")}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            <SettingsDialog
              title={t(`add${level}`)}
              trigger={<Button type="button" size="sm" disabled={!canEdit}>{t(`add${level}`)}</Button>}
            >
              <LocationForm level={level} location={null} />
            </SettingsDialog>
          </div>
        }
        rows={
          <>
            <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input
                  type="search"
                  // eslint-disable-next-line shadcn/no-restyle -- room for the search icon inside the field
                  className="pl-9"
                  value={search}
                  placeholder={t("search")}
                  aria-label={t("search")}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    changePage(1);
                  }}
                />
              </div>
              {level !== "city" ? (
                <SearchableSelect
                  value={parentFilter}
                  selectedLabel={parentFilterLabel}
                  clearable
                  ariaLabel={t("parent")}
                  triggerClassName="w-full sm:w-56"
                  load={deliveryLocationLoader({ type: PARENT[level], includeInactive: true })}
                  queryKey={[...queryKeys.settings.deliveryLocations(), "picker", PARENT[level], null, true]}
                  placeholder={t("allParents")}
                  searchPlaceholder={t("search")}
                  emptyMessage={t("empty")}
                  onValueChange={(value, option) => {
                    setParentFilter(value);
                    setParentFilterLabel(option?.label);
                    changePage(1);
                  }}
                />
              ) : null}
            </div>
            {level === "zone" ? (
              <p className="px-4 pb-3 text-body text-muted-foreground">{t("pathaoThanas")}</p>
            ) : null}
            {locations.length === 0 ? (
              <div className="space-y-2 border-t border-border px-4 py-8 text-center text-body text-muted-foreground">
                <p>{noPlaces ? t("noPlacesYet") : t("empty")}</p>
                {canEdit && !hasPathao && noPlaces ? (
                  <Link to="/admin/settings/shipping" hash="couriers" className="text-link hover:underline">{t("connectPathao")}</Link>
                ) : null}
              </div>
            ) : (
              <ul className="divide-y divide-border border-t border-border">
                <li className="flex min-h-11 items-center gap-3 px-4 text-body text-muted-foreground">
                  <Checkbox
                    aria-label={t("selectAll")}
                    disabled={!canEdit}
                    checked={selected.length === locations.length}
                    onCheckedChange={(checked) => setSelected(checked === true ? locations.map((location) => location.id) : [])}
                  />
                  <span className="flex-1">{selected.length ? t("selectedCount", { count: selected.length }) : t(level)}</span>
                  {selected.length ? (
                    <Button type="button" variant="destructive" size="sm" onClick={() => setConfirm("selected")}>
                      {t("deleteSelected")}
                    </Button>
                  ) : null}
                </li>
                {locations.map((location) => (
                  <li key={location.id} className="flex min-h-14 items-center gap-3 px-4 py-2">
                    <Checkbox
                      aria-label={t("selectRow", { name: location.name })}
                      disabled={!canEdit}
                      checked={selected.includes(location.id)}
                      onCheckedChange={(checked) =>
                        setSelected((current) => (checked === true ? [...current, location.id] : current.filter((id) => id !== location.id)))}
                    />
                    <SettingsDialog
                      title={t("editLocation", { name: location.name })}
                      trigger={
                        <button type="button" disabled={!canEdit} className="min-h-11 min-w-0 flex-1 text-left">
                          <span className="block truncate text-body font-medium">{location.name}</span>
                          <span className="block truncate text-body text-muted-foreground">
                            {[
                              location.parentPath?.length ? location.parentPath.join(" · ") : null,
                              location.externalIds?.pathao ? t("linkedPathao") : null,
                            ].filter(Boolean).join(" · ")}
                          </span>
                        </button>
                      }
                    >
                      <LocationForm level={level} location={location} />
                    </SettingsDialog>
                    <Switch
                      checked={location.isActive}
                      disabled={!canEdit || toggleActive.isPending}
                      aria-label={`${t("active")}: ${location.name}`}
                      onCheckedChange={() => toggleActive.mutate(location)}
                    />
                  </li>
                ))}
              </ul>
            )}
            {total > PAGE_SIZE ? (
              <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
                <p className="text-body text-muted-foreground">
                  {t("range", { from: (page - 1) * PAGE_SIZE + 1, to: Math.min(page * PAGE_SIZE, total), total })}
                </p>
                <div className="flex gap-1">
                  <Button type="button" variant="outline" size="icon" aria-label={t("previous")} disabled={page <= 1} onClick={() => changePage(page - 1)}>
                    <ChevronLeft aria-hidden="true" />
                  </Button>
                  <Button type="button" variant="outline" size="icon" aria-label={t("next")} disabled={page >= totalPages} onClick={() => changePage(page + 1)}>
                    <ChevronRight aria-hidden="true" />
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        }
      />
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={
          confirm === "import"
            ? t("importConfirmTitle")
            : onlySelected
              ? common("deleteNamed", { name: onlySelected.name })
              : t("deleteSelectedTitle", { count: selected.length })
        }
        description={
          confirm === "import"
            ? t("importConfirmBody")
            : onlySelected
              ? selectedUnder ? t("deleteWithChildren", { name: onlySelected.name, places: selectedUnder }) : t("deleteLocationConfirm")
              : selectedUnder ? t("deleteSelectedWithChildren", { places: selectedUnder }) : t("deleteLocationConfirm")
        }
        confirmLabel={confirm === "import" ? t("import") : common("delete")}
        cancelLabel={common("cancel")}
        variant={confirm === "import" ? "default" : "destructive"}
        isLoading={bulk.isPending}
        onConfirm={() => {
          if (confirm === "import") {
            setConfirm(null);
            void importer.start();
          } else if (confirm) {
            bulk.mutate(confirm);
          }
        }}
      />
      <DeleteAllDialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        count={placeTotal}
        deleting={bulk.isPending}
        onConfirm={() => bulk.mutate("all")}
      />
    </>
  );
}

/** Deleting every place can't be undone, so the merchant types the count first. */
function DeleteAllDialog({
  open,
  onOpenChange,
  count,
  deleting,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  count: number;
  deleting: boolean;
  onConfirm: () => void;
}) {
  const t = useMessages(shippingMessages);
  const common = useMessages(settingsMessages);
  const [typed, setTyped] = useState("");
  const shown = formatNumber(count);
  const matches = toLatinDigits(typed).replace(/[,\s]/g, "") === String(count);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setTyped("");
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("deleteAllTitle", { count: shown })}</AlertDialogTitle>
          <AlertDialogDescription>{t("deleteAllConfirm")}</AlertDialogDescription>
        </AlertDialogHeader>
        <SettingsField id="delete-all-confirm" label={t("deleteAllType", { count: shown })}>
          <Input id="delete-all-confirm" inputMode="numeric" autoComplete="off" value={typed} onChange={(event) => setTyped(event.target.value)} />
        </SettingsField>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>{common("cancel")}</AlertDialogCancel>
          <Button type="button" variant="destructive" loading={deleting} disabled={!matches} onClick={onConfirm}>
            {t("deleteAll")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
