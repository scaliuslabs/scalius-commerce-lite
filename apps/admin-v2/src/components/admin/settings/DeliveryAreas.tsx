import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, MoreHorizontal, Search } from "lucide-react";
import { toast } from "~/lib/toast";
import {
  deleteApiV1AdminSettingsDeliveryLocations,
  deleteApiV1AdminSettingsDeliveryLocationsAll,
  deleteApiV1AdminSettingsDeliveryLocationsById,
  postApiV1AdminSettingsDeliveryLocations,
  putApiV1AdminSettingsDeliveryLocationsById,
} from "@scalius/api-client/sdk";
import { PLACE_ADDRESS_COUNTRY, placeLevelName, placeLevels } from "@scalius/shared/places";
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
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Switch } from "~/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { useHasPermission } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { apiData } from "~/lib/api";
import { BANGLADESH_PACK_ID } from "~/lib/bangladesh-pack";
import { addressCountriesQueryOptions } from "~/lib/api-query-options/address-rules";
import {
  deliveryLocationLoader,
  deliveryLocationsQueryOptions,
  type DeliveryLocation,
} from "~/lib/api-query-options/delivery";
import { placeCountriesQueryOptions } from "~/lib/api-query-options/places";
import { countryName } from "~/lib/country-name";
import { queryKeys } from "~/lib/query-keys";
import { formatList } from "@scalius/shared/locale-words";
import { formatNumber, getLocale, useLocale, useMessages } from "~/i18n";
import { toLatinDigits } from "@scalius/shared/phone-input";
import { settingsMessages } from "~/i18n/settings";
import { shippingMessages } from "~/i18n/settings-shipping";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { useSaveBar } from "../shared/SaveBar";
import { SettingsCard, SettingsDialog, SettingsField } from "./SettingsPage";

const PAGE_SIZE = 20;

/** Live places under a place, by level (`{ "2": 1, "3": 4 }`). */
type Descendants = Record<string, number>;
const descendantsOf = (location: DeliveryLocation): Descendants => location.descendants ?? {};

/** A country's level names in the dashboard language: singular, plural and in a sentence. */
function useLevelNames(country: string) {
  const locale = useLocale();
  return {
    one: (level: number) => placeLevelName(country, level, locale),
    many: (level: number) => placeLevelName(country, level, locale, { plural: true }),
    word: (level: number, count = 1) => placeLevelName(country, level, locale, { plural: count !== 1 }).toLocaleLowerCase(locale),
  };
}

/** "1 thana and 3 areas", or null when nothing is under the places being deleted. */
function usePlacesUnder(country: string) {
  const t = useMessages(shippingMessages);
  const names = useLevelNames(country);
  return (descendants: Descendants): string | null => {
    const parts = Object.entries(descendants)
      .filter(([, count]) => count > 0)
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([level, count]) => t("levelCount", { count: formatNumber(count), name: names.word(Number(level), count) }));
    if (parts.length === 0) return null;
    return formatList(parts, getLocale());
  };
}

function sumDescendants(list: Descendants[]): Descendants {
  const total: Descendants = {};
  for (const entry of list) {
    for (const [level, count] of Object.entries(entry)) total[level] = (total[level] ?? 0) + count;
  }
  return total;
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

function LocationForm({ country, level, location }: { country: string; level: number; location: DeliveryLocation | null }) {
  const t = useMessages(shippingMessages);
  const common = useMessages(settingsMessages);
  const names = useLevelNames(country);
  const refresh = useRefreshAreas();
  const placesUnder = usePlacesUnder(country);
  const [saved] = useState(() => ({
    name: location?.name ?? "",
    parentId: location?.parentId ?? "",
    isActive: location?.isActive ?? true,
  }));
  const [draft, setDraft] = useState(saved);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const under = location ? placesUnder(descendantsOf(location)) : null;
  const top = level === 1;
  const save = useMutation({
    mutationFn: (): Promise<unknown> => {
      // Courier ids (externalIds) come from imports, matched by name.
      const fields = {
        name: draft.name.trim(),
        parentId: top ? null : draft.parentId || null,
        externalIds: (location?.externalIds ?? {}) as Record<string, string | number>,
        metadata: (location?.metadata ?? {}) as Record<string, string>,
        isActive: draft.isActive,
      };
      return location
        ? apiData(putApiV1AdminSettingsDeliveryLocationsById({ path: { id: location.id }, body: fields }))
        : apiData(postApiV1AdminSettingsDeliveryLocations({ body: { ...fields, countryCode: country, level } }));
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
    invalid: !draft.name.trim() || (!top && !draft.parentId),
    save: () => save.mutateAsync(),
    discard: () => setDraft(saved),
  });
  return (
    <>
      <SettingsField id="location-name" label={names.one(level)} error={draft.name ? null : t("nameRequired")}>
        <Input id="location-name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
      </SettingsField>
      {!top ? (
        <SettingsField id="location-parent" label={t("parent")} error={draft.parentId ? null : t("parentRequired")}>
          <SearchableSelect
            id="location-parent"
            value={draft.parentId}
            selectedLabel={draft.parentId === location?.parentId ? location?.parentPath?.[0] : undefined}
            triggerClassName="w-full"
            load={deliveryLocationLoader({ country, level: level - 1, includeInactive: true })}
            queryKey={[...queryKeys.settings.deliveryLocations(), "picker", country, level - 1, null, true]}
            placeholder={names.one(level - 1)}
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

/** Add a country: it is listed with no places, ready for its first top-level place. */
function AddCountryForm({ taken, onAdd }: { taken: ReadonlySet<string>; onAdd: (country: string) => void }) {
  const t = useMessages(shippingMessages);
  const [country, setCountry] = useState("");
  const codes = useQuery(addressCountriesQueryOptions()).data ?? [];
  const options = codes
    .filter((code) => !taken.has(code))
    .map((code) => ({ value: code, label: countryName(code), keywords: [code] }))
    .sort((left, right) => left.label.localeCompare(right.label));
  useSaveBar({
    fields: { country: "place-country" },
    dirty: country !== "",
    saving: false,
    invalid: !country,
    save: async () => onAdd(country),
    discard: () => setCountry(""),
  });
  return (
    <SettingsField id="place-country" label={t("countryLabel")} help={t("addCountryHelp")}>
      <SearchableSelect
        id="place-country"
        value={country}
        onValueChange={setCountry}
        options={options}
        placeholder={t("chooseCountry")}
        searchPlaceholder={t("searchCountries")}
        emptyMessage={t("empty")}
        ariaLabel={t("countryLabel")}
        triggerClassName="w-full"
      />
    </SettingsField>
  );
}

/**
 * The place directory by country: a country selector (the countries that
 * have places, and Add country), the country's levels as tabs, and a
 * searchable, paged list of one level's places.
 */
export function DeliveryAreasManager() {
  const t = useMessages(shippingMessages);
  const common = useMessages(settingsMessages);
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_EDIT);
  const refresh = useRefreshAreas();
  const countries = useQuery(placeCountriesQueryOptions()).data;
  const [added, setAdded] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  // Bangladesh first when it has places (its addresses pick from them), else the first country.
  const country = chosen
    ?? (countries && countries.length > 0 && !countries.some((entry) => entry.countryCode === PLACE_ADDRESS_COUNTRY)
      ? countries[0]!.countryCode
      : PLACE_ADDRESS_COUNTRY);
  // The countries with places, the ones added this visit and the one shown.
  const listed = [...new Set([...(countries ?? []).map((entry) => entry.countryCode), ...added, country])];
  const countryCount = countries?.find((entry) => entry.countryCode === country)?.places ?? 0;
  const bangladesh = country === PLACE_ADDRESS_COUNTRY;
  const levels = placeLevels(country).map((_, index) => index + 1);
  const names = useLevelNames(country);
  const placesUnder = usePlacesUnder(country);
  const [level, setLevel] = useState(1);
  const [search, setSearch] = useState("");
  const [parentFilter, setParentFilter] = useState("");
  const [parentFilterLabel, setParentFilterLabel] = useState<string | undefined>();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<"selected" | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const noPlaces = countries !== undefined && countryCount === 0;

  const list = useQuery({
    ...deliveryLocationsQueryOptions({
      country,
      level,
      page,
      limit: PAGE_SIZE,
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(level > 1 && parentFilter ? { parentId: parentFilter } : {}),
    }),
    placeholderData: (previous) => previous,
  });
  const locations = list.data?.locations ?? [];
  const selectedUnder = placesUnder(sumDescendants(locations.filter((location) => selected.includes(location.id)).map(descendantsOf)));
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
        ? apiData(deleteApiV1AdminSettingsDeliveryLocationsAll({ body: { confirmDeleteAll: true, countryCode: country } }))
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

  const reset = () => {
    setSearch("");
    setParentFilter("");
    setParentFilterLabel(undefined);
    setPage(1);
    setSelected([]);
  };
  const changeLevel = (next: number) => {
    setLevel(next);
    reset();
  };
  const changeCountry = (next: string) => {
    setChosen(next);
    setLevel(1);
    reset();
  };
  // Selection is per page, so the delete confirmation can count what's under it.
  const changePage = (next: number) => {
    setPage(next);
    setSelected([]);
  };
  const countryOptions = listed.map((code) => {
    const count = countries?.find((entry) => entry.countryCode === code)?.places ?? 0;
    return { value: code, label: countryName(code), description: t("placeCount", { count: formatNumber(count) }), keywords: [code] };
  });

  return (
    <>
      <SettingsCard
        header={
          <Tabs value={String(level)} onValueChange={(value) => changeLevel(Number(value))} className="me-auto">
            <TabsList>
              {levels.map((value) => (
                <TabsTrigger key={value} value={String(value)}>{names.many(value)}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        }
        action={
          <div className="flex gap-2">
            {canEdit && bangladesh ? (
              // The Bangladesh pack loads the places and refreshes them from Pathao's live list.
              <Button asChild variant="outline" size="sm">
                <Link to="/admin/apps/$pluginId/pages/$pageId" params={{ pluginId: BANGLADESH_PACK_ID, pageId: "places" }}>{t("bangladeshPlaces")}</Link>
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
                  <DropdownMenuItem disabled={countryCount === 0} onSelect={() => setConfirmAll(true)}>{t("deleteAll")}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            <SettingsDialog
              title={t("addPlace", { name: names.word(level) })}
              trigger={<Button type="button" size="sm" disabled={!canEdit}>{t("addPlace", { name: names.word(level) })}</Button>}
            >
              <LocationForm key={`${country}-${level}`} country={country} level={level} location={null} />
            </SettingsDialog>
          </div>
        }
        rows={
          <>
            <div className="flex flex-col gap-2 px-4 pt-3 sm:flex-row sm:items-center">
              <SearchableSelect
                value={country}
                onValueChange={(value) => value && changeCountry(value)}
                options={countryOptions}
                ariaLabel={t("countryLabel")}
                searchPlaceholder={t("searchCountries")}
                emptyMessage={t("empty")}
                triggerClassName="w-full sm:w-64"
              />
              {canEdit ? (
                <SettingsDialog
                  title={t("addCountryTitle")}
                  savedMessage={t("countryAdded")}
                  trigger={<Button type="button" variant="outline" size="sm">{t("addCountry")}</Button>}
                >
                  <AddCountryForm
                    taken={new Set(listed)}
                    onAdd={(code) => {
                      setAdded((current) => [...current, code]);
                      changeCountry(code);
                    }}
                  />
                </SettingsDialog>
              ) : null}
            </div>
            <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute inset-s-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input
                  type="search"
                  // eslint-disable-next-line shadcn/no-restyle -- room for the search icon inside the field
                  className="ps-9"
                  value={search}
                  placeholder={t("search")}
                  aria-label={t("search")}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    changePage(1);
                  }}
                />
              </div>
              {level > 1 ? (
                <SearchableSelect
                  value={parentFilter}
                  selectedLabel={parentFilterLabel}
                  clearable
                  ariaLabel={t("parent")}
                  triggerClassName="w-full sm:w-56"
                  load={deliveryLocationLoader({ country, level: level - 1, includeInactive: true })}
                  queryKey={[...queryKeys.settings.deliveryLocations(), "picker", country, level - 1, null, true]}
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
            {bangladesh && level === 2 ? (
              <p className="px-4 pb-3 text-body text-muted-foreground">{t("pathaoThanas")}</p>
            ) : null}
            {locations.length === 0 ? (
              <div className="space-y-2 border-t border-border px-4 py-8 text-center text-body text-muted-foreground">
                <p>
                  {!noPlaces
                    ? t("empty")
                    : bangladesh
                      ? t("noPlacesYet")
                      : t("noPlacesCountry", { country: countryName(country), name: names.word(1, 2) })}
                </p>
                {canEdit && bangladesh && noPlaces ? (
                  <Link to="/admin/apps/$pluginId/pages/$pageId" params={{ pluginId: BANGLADESH_PACK_ID, pageId: "places" }} className="text-link hover:underline">{t("loadBangladeshPlaces")}</Link>
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
                  <span className="flex-1">{selected.length ? t("selectedCount", { count: selected.length }) : names.one(level)}</span>
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
                        <button type="button" disabled={!canEdit} className="min-h-11 min-w-0 flex-1 text-start">
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
                      <LocationForm country={country} level={level} location={location} />
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
          onlySelected
            ? common("deleteNamed", { name: onlySelected.name })
            : t("deleteSelectedTitle", { count: selected.length })
        }
        description={
          onlySelected
            ? selectedUnder ? t("deleteWithChildren", { name: onlySelected.name, places: selectedUnder }) : t("deleteLocationConfirm")
            : selectedUnder ? t("deleteSelectedWithChildren", { places: selectedUnder }) : t("deleteLocationConfirm")
        }
        confirmLabel={common("delete")}
        cancelLabel={common("cancel")}
        variant="destructive"
        isLoading={bulk.isPending}
        onConfirm={() => {
          if (confirm) bulk.mutate(confirm);
        }}
      />
      <DeleteAllDialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        country={country}
        count={countryCount}
        deleting={bulk.isPending}
        onConfirm={() => bulk.mutate("all")}
      />
    </>
  );
}

/** Deleting every place of a country can't be undone, so the merchant types the count first. */
function DeleteAllDialog({
  open,
  onOpenChange,
  country,
  count,
  deleting,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  country: string;
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
          <AlertDialogDescription>{t("deleteAllConfirm", { country: countryName(country) })}</AlertDialogDescription>
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
