import { Fragment, useDeferredValue, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus, Search, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useCurrency } from "~/hooks/use-currency";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { apiClient, apiData } from "~/lib/api";
import {
  allDeliveryLocationsQueryOptions,
  deliveryLocationsQueryOptions,
  type DeliveryLocation,
} from "~/lib/api-query-options/delivery";
import { parseAmountInput } from "~/lib/money-input";
import { queryKeys } from "~/lib/query-keys";
import { useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { shippingMessages } from "~/i18n/settings-shipping";
import { cn } from "@scalius/shared/utils";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { useSaveBar } from "../shared/SaveBar";
import { SettingsLoadFailure } from "./SettingsLoadFailure";
import { SettingsCard, SettingsCardLoading, SettingsDialog, SettingsField, SettingsRow } from "./SettingsPage";
import { areaCountsQuery } from "./ShippingSettings";

// TODO(sdk): the generated SDK predates delivery zones; switch these raw calls
// to it after `pnpm generate:sdk`.
const ZONES_URL = "/api/v1/admin/settings/shipping-methods";

type Kind = "delivery" | "pickup";
interface Rate {
  id: string;
  kind: Kind;
  name: string;
  fee: number;
  freeOver: number | null;
  description: string | null;
  pickupAddress: string | null;
  pickupHours: string | null;
  isActive: boolean;
}
interface Place {
  id: string;
  name: string;
  type: "city" | "zone" | "area";
  parentName: string | null;
}
interface Zone {
  id: string;
  name: string;
  revision: number;
  locations: Place[];
  rates: Rate[];
}
export interface DeliveryZones {
  zones: Zone[];
  everywhereElse: { revision: number; rates: Rate[] };
}

const json = { "Content-Type": "application/json" };
const send = (method: "post" | "put" | "delete", url: string, body?: unknown) =>
  apiData(apiClient[method]({ url, headers: json, ...(body === undefined ? {} : { body }) }));

export const deliveryZonesQuery = {
  queryKey: queryKeys.settings.shippingMethods(),
  queryFn: () => apiData(apiClient.get<{ 200: { data: DeliveryZones } }>({ url: ZONES_URL })),
};

function useRefreshZones() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.shippingMethods() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.checkoutReadiness() }),
    ]);
}

/** A save built on a stale revision reloads the list so reopening shows the latest. */
function useConflictReload() {
  const refresh = useRefreshZones();
  return (error: unknown) => {
    if (error instanceof AdminApiResponseError && error.status === 409) void refresh();
  };
}

// ── Charges (rates) editor ─────────────────────────────────────────────

interface RateDraft {
  key: string;
  id: string | null;
  kind: Kind;
  name: string;
  fee: string;
  freeOver: string;
  description: string;
  pickupAddress: string;
  pickupHours: string;
  isActive: boolean;
}

const MAX_AMOUNT = 100_000;

function toDraft(rate: Rate): RateDraft {
  return {
    key: rate.id,
    id: rate.id,
    kind: rate.kind,
    name: rate.name,
    fee: String(rate.fee),
    freeOver: rate.freeOver === null ? "" : String(rate.freeOver),
    description: rate.description ?? "",
    pickupAddress: rate.pickupAddress ?? "",
    pickupHours: rate.pickupHours ?? "",
    isActive: rate.isActive,
  };
}

function emptyDraft(): RateDraft {
  return {
    key: crypto.randomUUID(),
    id: null,
    kind: "delivery",
    name: "",
    fee: "",
    freeOver: "",
    description: "",
    pickupAddress: "",
    pickupHours: "",
    isActive: true,
  };
}

type RateErrorKey = "rateNameRequired" | "feeInvalid" | "feeTooHigh" | "freeOverTooHigh" | "pickupAddressRequired";

/** A charge as typed; an empty pickup charge means free pickup. */
function feeOf(rate: RateDraft): number | null {
  return rate.kind === "pickup" && !rate.fee.trim() ? 0 : parseAmountInput(rate.fee);
}

/** What's wrong with each field of a charge, or nothing. */
export function rateErrors(rate: RateDraft): Partial<Record<"name" | "fee" | "freeOver" | "pickupAddress", RateErrorKey>> {
  const fee = feeOf(rate);
  const freeOver = rate.freeOver.trim() ? parseAmountInput(rate.freeOver) : null;
  return {
    ...(rate.name.trim() ? {} : { name: "rateNameRequired" as const }),
    ...(fee === null ? { fee: "feeInvalid" as const } : fee > MAX_AMOUNT ? { fee: "feeTooHigh" as const } : {}),
    ...(rate.freeOver.trim() && freeOver === null
      ? { freeOver: "feeInvalid" as const }
      : freeOver !== null && freeOver > MAX_AMOUNT ? { freeOver: "freeOverTooHigh" as const } : {}),
    ...(rate.kind === "pickup" && !rate.pickupAddress.trim() ? { pickupAddress: "pickupAddressRequired" as const } : {}),
  };
}

function toRateInput(rate: RateDraft) {
  return {
    id: rate.id,
    kind: rate.kind,
    name: rate.name.trim(),
    fee: feeOf(rate) ?? 0,
    freeOver: rate.freeOver.trim() ? parseAmountInput(rate.freeOver) : null,
    description: rate.description.trim() || null,
    pickupAddress: rate.kind === "pickup" ? rate.pickupAddress.trim() : null,
    pickupHours: rate.kind === "pickup" ? rate.pickupHours.trim() || null : null,
    isActive: rate.isActive,
  };
}

/** API body paths (`rates.0.fee`) to the controls showing them. */
function fieldId(path: string): string | undefined {
  if (path === "name") return "zone-name";
  if (path === "locationIds") return "zone-places";
  const match = /^rates\.(\d+)\.(\w+)$/.exec(path);
  return match ? `rate-${match[1]}-${match[2]}` : undefined;
}

function RatesEditor({
  rates,
  onChange,
  allowPickup,
}: {
  rates: RateDraft[];
  onChange: (rates: RateDraft[]) => void;
  allowPickup: boolean;
}) {
  const t = useMessages(shippingMessages);
  const { symbol } = useCurrency();
  const update = (index: number, patch: Partial<RateDraft>) =>
    onChange(rates.map((rate, i) => (i === index ? { ...rate, ...patch } : rate)));
  return (
    <section className="space-y-4 border-t border-border pt-4">
      <h3 className="text-heading-sm">{t("charges")}</h3>
      {rates.map((rate, index) => {
        const errors = rateErrors(rate);
        const id = (field: string) => `rate-${index}-${field}`;
        return (
          <fieldset key={rate.key} className="space-y-4 border-t border-border pt-4 first-of-type:border-t-0 first-of-type:pt-0">
            {allowPickup ? (
              <SettingsField id={id("kind")} label={t("kind")}>
                <RadioGroup
                  id={id("kind")}
                  value={rate.kind}
                  // Pickup is usually free: a new pickup charge starts at 0.
                  onValueChange={(kind) =>
                    update(index, { kind: kind as Kind, ...(kind === "pickup" && !rate.fee.trim() ? { fee: "0" } : {}) })}
                >
                  {(["delivery", "pickup"] as const).map((kind) => (
                    <label key={kind} className="flex min-h-11 items-center gap-2 text-body">
                      <RadioGroupItem value={kind} />
                      {t(kind === "delivery" ? "kindDelivery" : "kindPickup")}
                    </label>
                  ))}
                </RadioGroup>
              </SettingsField>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <SettingsField id={id("name")} label={t("rateName")} error={errors.name ? t(errors.name) : null}>
                  <Input id={id("name")} value={rate.name} placeholder={t("rateNamePlaceholder")} onChange={(event) => update(index, { name: event.target.value })} />
                </SettingsField>
              </div>
              <SettingsField
                id={id("fee")}
                label={`${t("fee")} (${symbol})`}
                help={rate.kind === "pickup" ? t("pickupFeeHelp") : undefined}
                error={errors.fee ? t(errors.fee) : null}
              >
                <Input
                  id={id("fee")}
                  inputMode="decimal"
                  autoComplete="off"
                  value={rate.fee}
                  aria-describedby={rate.kind === "pickup" ? `${id("fee")}-note` : undefined}
                  onChange={(event) => update(index, { fee: event.target.value })}
                />
              </SettingsField>
            </div>
            <SettingsField
              id={id("freeOver")}
              label={`${t("freeOver")} (${symbol})`}
              help={t("freeOverHelp")}
              error={errors.freeOver ? t(errors.freeOver) : null}
            >
              <Input
                id={id("freeOver")}
                inputMode="decimal"
                autoComplete="off"
                className="sm:max-w-48"
                value={rate.freeOver}
                aria-describedby={`${id("freeOver")}-note`}
                onChange={(event) => update(index, { freeOver: event.target.value })}
              />
            </SettingsField>
            {rate.kind === "pickup" ? (
              <>
                <SettingsField id={id("pickupAddress")} label={t("pickupAddress")} error={errors.pickupAddress ? t(errors.pickupAddress) : null}>
                  <Textarea id={id("pickupAddress")} rows={2} maxLength={500} value={rate.pickupAddress} onChange={(event) => update(index, { pickupAddress: event.target.value })} />
                </SettingsField>
                <SettingsField id={id("pickupHours")} label={t("pickupHours")}>
                  <Input id={id("pickupHours")} maxLength={120} value={rate.pickupHours} placeholder={t("pickupHoursPlaceholder")} onChange={(event) => update(index, { pickupHours: event.target.value })} />
                </SettingsField>
              </>
            ) : null}
            <SettingsField id={id("description")} label={t("rateDescription")}>
              <Input id={id("description")} maxLength={255} value={rate.description} placeholder={t("rateDescriptionPlaceholder")} onChange={(event) => update(index, { description: event.target.value })} />
            </SettingsField>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex min-h-11 items-center gap-3 text-body font-medium">
                <Switch checked={rate.isActive} onCheckedChange={(isActive) => update(index, { isActive })} />
                {t("showAtCheckout")}
              </label>
              <Button type="button" variant="ghost" onClick={() => onChange(rates.filter((_, i) => i !== index))}>
                {t("removeCharge")}
              </Button>
            </div>
          </fieldset>
        );
      })}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...rates, emptyDraft()])}>
        <Plus aria-hidden="true" />
        {t("addCharge")}
      </Button>
    </section>
  );
}

// ── Place picker (city → zone → area) ──────────────────────────────────

function PlaceRow({
  place,
  label,
  depth,
  selected,
  takenBy,
  onToggle,
  expanded,
  onExpand,
}: {
  place: DeliveryLocation;
  label: string;
  depth: number;
  selected: boolean;
  takenBy: string | undefined;
  onToggle: (checked: boolean) => void;
  expanded?: boolean;
  onExpand?: () => void;
}) {
  const t = useMessages(shippingMessages);
  return (
    <li className={cn("flex min-h-11 items-center gap-2 pr-3", depth === 0 ? "pl-2" : depth === 1 ? "pl-8" : "pl-14")}>
      {onExpand ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-expanded={expanded}
          aria-label={t("showPlaces", { name: place.name })}
          onClick={onExpand}
        >
          <ChevronRight aria-hidden="true" className={cn("transition-transform", expanded && "rotate-90")} />
        </Button>
      ) : (
        <span className="w-7 shrink-0" aria-hidden="true" />
      )}
      <label className="flex min-w-0 flex-1 items-center gap-3 text-body">
        <Checkbox checked={selected} disabled={Boolean(takenBy)} onCheckedChange={(checked) => onToggle(checked === true)} />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {takenBy ? <span className="shrink-0 text-muted-foreground">{t("inZone", { zone: takenBy })}</span> : null}
      </label>
    </li>
  );
}

function AreasOf({ zoneId, ...row }: { zoneId: string } & Omit<Parameters<typeof PlaceList>[0], "places" | "depth">) {
  const areas = useQuery(deliveryLocationsQueryOptions({ type: "area", parentId: zoneId, limit: 500 }));
  return <PlaceList {...row} places={areas.data?.locations ?? []} depth={2} />;
}

function PlaceList({
  places,
  depth,
  isSelected,
  takenBy,
  toggle,
  children,
  label,
}: {
  places: DeliveryLocation[];
  depth: number;
  isSelected: (id: string) => boolean;
  takenBy: (id: string) => string | undefined;
  toggle: (place: DeliveryLocation, checked: boolean) => void;
  children?: (place: DeliveryLocation) => { expanded: boolean; onExpand: () => void; nested: ReactNode } | null;
  label?: (place: DeliveryLocation) => string;
}) {
  return (
    <>
      {places.map((place) => {
        const nested = children?.(place) ?? null;
        return (
          <Fragment key={place.id}>
            <PlaceRow
              place={place}
              label={label?.(place) ?? place.name}
              depth={depth}
              selected={isSelected(place.id)}
              takenBy={takenBy(place.id)}
              onToggle={(checked) => toggle(place, checked)}
              expanded={nested?.expanded}
              onExpand={nested?.onExpand}
            />
            {nested?.expanded ? nested.nested : null}
          </Fragment>
        );
      })}
    </>
  );
}

function PlacePicker({
  selected,
  onChange,
  taken,
  error,
}: {
  selected: Place[];
  onChange: (places: Place[]) => void;
  /** Places already in another zone → that zone's name. */
  taken: Map<string, string>;
  error: string | null;
}) {
  const t = useMessages(shippingMessages);
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search.trim().toLowerCase());
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const cities = useQuery(allDeliveryLocationsQueryOptions({ type: "city" })).data?.locations ?? [];
  const zones = useQuery(allDeliveryLocationsQueryOptions({ type: "zone" })).data?.locations ?? [];
  const areaMatches = useQuery({
    ...deliveryLocationsQueryOptions({ type: "area", search: query, limit: 50 }),
    enabled: query.length >= 2,
  }).data?.locations ?? [];
  const cityName = new Map(cities.map((city) => [city.id, city.name]));
  const zoneById = new Map(zones.map((zone) => [zone.id, zone]));
  const parentName = (place: DeliveryLocation): string | null => {
    if (place.type === "zone") return cityName.get(place.parentId ?? "") ?? null;
    if (place.type !== "area") return null;
    const zone = zoneById.get(place.parentId ?? "");
    return zone ? [zone.name, cityName.get(zone.parentId ?? "")].filter(Boolean).join(", ") : null;
  };
  const chosen = new Set(selected.map((place) => place.id));
  const toggle = (place: DeliveryLocation, checked: boolean) =>
    onChange(checked
      ? [...selected, { id: place.id, name: place.name, type: place.type, parentName: parentName(place) }]
      : selected.filter((item) => item.id !== place.id));
  const flip = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const rowProps = {
    isSelected: (id: string) => chosen.has(id),
    takenBy: (id: string) => taken.get(id),
    toggle,
  };
  const matches = query
    ? [...cities, ...zones, ...areaMatches].filter((place) => place.name.toLowerCase().includes(query))
    : [];

  return (
    <SettingsField id="zone-places" label={t("zonePlaces")} help={t("zonePlacesHelp")} error={error}>
      <div className="space-y-2">
        {selected.length ? (
          <ul className="flex flex-wrap gap-2" aria-label={t("placeCount", { count: selected.length })}>
            {selected.map((place) => (
              <li key={place.id} className="flex items-center gap-1 rounded-lg bg-secondary py-0.5 pl-2 text-body">
                {place.parentName ? `${place.name}, ${place.parentName}` : place.name}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("removePlace", { name: place.name })}
                  onClick={() => onChange(selected.filter((item) => item.id !== place.id))}
                >
                  <X aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            id="zone-places"
            type="search"
            // eslint-disable-next-line shadcn/no-restyle -- room for the search icon inside the field
            className="pl-9"
            value={search}
            placeholder={t("searchPlaces")}
            aria-describedby="zone-places-note"
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <ul className="max-h-72 overflow-y-auto rounded-lg border border-border py-1">
          {query ? (
            matches.length ? (
              <PlaceList
                {...rowProps}
                places={matches}
                depth={0}
                label={(place) => [place.name, parentName(place)].filter(Boolean).join(", ")}
              />
            ) : (
              <li className="px-3 py-2 text-body text-muted-foreground">{t("noPlaces")}</li>
            )
          ) : (
            <PlaceList
              {...rowProps}
              places={cities}
              depth={0}
              children={(city) => ({
                expanded: open.has(city.id),
                onExpand: () => flip(city.id),
                nested: (
                  <PlaceList
                    {...rowProps}
                    places={zones.filter((zone) => zone.parentId === city.id)}
                    depth={1}
                    children={(zone) => ({
                      expanded: open.has(zone.id),
                      onExpand: () => flip(zone.id),
                      nested: <AreasOf {...rowProps} zoneId={zone.id} />,
                    })}
                  />
                ),
              })}
            />
          )}
        </ul>
      </div>
    </SettingsField>
  );
}

// ── Zone and "Everywhere else" forms ───────────────────────────────────

function ZoneForm({ zone, zones }: { zone: Zone | null; zones: Zone[] }) {
  const t = useMessages(shippingMessages);
  const common = useMessages(settingsMessages);
  const refresh = useRefreshZones();
  const onConflict = useConflictReload();
  const [saved] = useState(() => ({
    name: zone?.name ?? "",
    places: zone?.locations ?? [],
    rates: zone ? zone.rates.map(toDraft) : [emptyDraft()],
  }));
  const [draft, setDraft] = useState(saved);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const taken = new Map(
    zones.filter((other) => other.id !== zone?.id).flatMap((other) => other.locations.map((place) => [place.id, other.name] as const)),
  );
  const body = () => ({
    name: draft.name.trim(),
    locationIds: draft.places.map((place) => place.id),
    rates: draft.rates.map(toRateInput),
  });
  const save = useMutation({
    mutationFn: () =>
      zone
        ? send("put", `${ZONES_URL}/${encodeURIComponent(zone.id)}`, { ...body(), expectedRevision: zone.revision })
        : send("post", ZONES_URL, body()),
    onSuccess: refresh,
    onError: onConflict,
  });
  const remove = useMutation({
    mutationFn: () => send("delete", `${ZONES_URL}/${encodeURIComponent(zone!.id)}`),
    onSuccess: async () => {
      toast.success(t("zoneDeleted"));
      await refresh();
    },
    onError: () => toast.error(common("saveFailed")),
  });
  useSaveBar({
    fields: fieldId,
    dirty: JSON.stringify(draft) !== JSON.stringify(saved),
    saving: save.isPending,
    invalid: !draft.name.trim() || draft.places.length === 0 || draft.rates.some((rate) => Object.keys(rateErrors(rate)).length > 0),
    save: () => save.mutateAsync(),
    discard: () => setDraft(saved),
  });
  return (
    <>
      <SettingsField id="zone-name" label={t("zoneName")} error={draft.name.trim() ? null : t("zoneNameRequired")}>
        <Input id="zone-name" value={draft.name} maxLength={100} placeholder={t("zoneNamePlaceholder")} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
      </SettingsField>
      <PlacePicker
        selected={draft.places}
        taken={taken}
        error={draft.places.length ? null : t("zonePlacesRequired")}
        onChange={(places) => setDraft({ ...draft, places })}
      />
      <RatesEditor rates={draft.rates} allowPickup={false} onChange={(rates) => setDraft({ ...draft, rates })} />
      {zone ? (
        <>
          <Button type="button" variant="ghost" className="self-start" onClick={() => setConfirmDelete(true)}>
            {t("deleteZone")}
          </Button>
          <ConfirmDialog
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title={common("deleteNamed", { name: zone.name })}
            description={t("deleteZoneConfirm")}
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

function EverywhereElseForm({ everywhereElse }: { everywhereElse: DeliveryZones["everywhereElse"] }) {
  const refresh = useRefreshZones();
  const onConflict = useConflictReload();
  const [saved] = useState(() => everywhereElse.rates.map(toDraft));
  const [rates, setRates] = useState(saved);
  const save = useMutation({
    mutationFn: () =>
      send("put", `${ZONES_URL}/everywhere-else`, { rates: rates.map(toRateInput), expectedRevision: everywhereElse.revision }),
    onSuccess: refresh,
    onError: onConflict,
  });
  useSaveBar({
    fields: fieldId,
    dirty: JSON.stringify(rates) !== JSON.stringify(saved),
    saving: save.isPending,
    invalid: rates.some((rate) => Object.keys(rateErrors(rate)).length > 0),
    save: () => save.mutateAsync(),
    discard: () => setRates(saved),
  });
  return <RatesEditor rates={rates} allowPickup onChange={setRates} />;
}

// ── The card ───────────────────────────────────────────────────────────

const TEMPLATES = [
  { id: "dhaka_two_zone", title: "templateTwo", value: "templateTwoValue", inside: 60 },
  { id: "dhaka_three_zone", title: "templateThree", value: "templateThreeValue", inside: 70 },
] as const;

export function DeliveryZonesCard() {
  const t = useMessages(shippingMessages);
  const common = useMessages(settingsMessages);
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_SHIPPING_METHODS_EDIT);
  const canView = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_SHIPPING_METHODS_VIEW);
  const { fmt } = useCurrency();
  const refresh = useRefreshZones();
  const { data, isError, refetch } = useQuery({ ...deliveryZonesQuery, enabled: canView });
  const canViewPlaces = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_VIEW);
  const placeCounts = useQuery({ ...areaCountsQuery, enabled: canViewPlaces }).data;
  const hasPlaces = placeCounts ? placeCounts.cities > 0 : true;
  const [template, setTemplate] = useState<(typeof TEMPLATES)[number]["id"] | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const applyTemplate = useMutation({
    mutationFn: (id: string) =>
      send("put", `${ZONES_URL}/template`, { template: id, expectedRevision: data!.everywhereElse.revision }),
    onSuccess: async () => {
      setTemplate(null);
      toast.success(t("templateAdded"));
      await refresh();
    },
    onError: (error) => {
      setTemplate(null);
      setTemplateError(error instanceof Error ? error.message : common("saveFailed"));
    },
  });
  if (!canView) return null;
  if (isError) return <SettingsLoadFailure title={t("loadZones")} onRetry={refetch} />;
  if (!data) return <SettingsCardLoading />;

  const summary = (rates: Rate[]) =>
    rates.length === 0
      ? t("noCharges")
      : rates.map((rate) => [
          rate.kind === "pickup" ? `${t("pickup")}: ${rate.name}` : rate.name,
          rate.fee === 0 ? t("free") : fmt(rate.fee),
          rate.freeOver === null ? null : t("freeOverSummary", { amount: fmt(rate.freeOver) }),
          rate.isActive ? null : t("off"),
        ].filter(Boolean).join(" ")).join(" · ");
  const places = (zone: Zone) =>
    zone.locations.length === 0
      ? t("noPlacesInZone")
      : zone.locations.length <= 2
        ? zone.locations.map((place) => place.name).join(", ")
        : t("placeCount", { count: zone.locations.length });

  return (
    <SettingsCard
      id="deliveryCharges"
      title={t("zonesTitle")}
      description={data.zones.length ? t("zonesDescription") : t("noZones")}
      action={
        <SettingsDialog title={t("addZone")} trigger={<Button type="button" variant="outline" size="sm" disabled={!canEdit}>{t("addZone")}</Button>}>
          <ZoneForm zone={null} zones={data.zones} />
        </SettingsDialog>
      }
      rows={
        <>
          {data.zones.map((zone) => (
            <SettingsDialog key={zone.id} title={t("editZone", { name: zone.name })} trigger={
              <SettingsRow disabled={!canEdit} label={zone.name} value={`${places(zone)} · ${summary(zone.rates)}`} />
            }>
              <ZoneForm zone={zone} zones={data.zones} />
            </SettingsDialog>
          ))}
          <SettingsDialog title={t("everywhereElse")} description={t("everywhereElseHelp")} trigger={
            <SettingsRow
              disabled={!canEdit}
              label={t("everywhereElse")}
              value={data.everywhereElse.rates.length ? summary(data.everywhereElse.rates) : t("noDeliveryElsewhere")}
            />
          }>
            <EverywhereElseForm everywhereElse={data.everywhereElse} />
          </SettingsDialog>
          {data.zones.length === 0 && canEdit ? (
            // Suggestions, not zones: nothing here is live until the merchant uses one.
            <section aria-labelledby="suggested-setups" className="border-t border-border">
              <h3 id="suggested-setups" className="px-4 pt-3 text-heading-sm text-muted-foreground">{t("suggestedSetups")}</h3>
              {templateError ? <p role="alert" className="px-4 pt-2 text-body text-destructive">{templateError}</p> : null}
              <ul>
                {TEMPLATES.map((option) => (
                  <li key={option.id} className="flex min-h-14 items-center gap-3 px-4 py-3">
                    <span className="min-w-0 flex-1">
                      <span className="block text-body font-medium">{t(option.title)}</span>
                      <span className="block text-body text-muted-foreground">
                        {t(option.value, { inside: fmt(option.inside), near: fmt(90), outside: fmt(120) })}
                      </span>
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!hasPlaces}
                      aria-label={t("useNamed", { name: t(option.title) })}
                      onClick={() => {
                        setTemplateError(null);
                        setTemplate(option.id);
                      }}
                    >
                      {t("use")}
                    </Button>
                  </li>
                ))}
              </ul>
              {!hasPlaces ? (
                <p className="px-4 pb-3 text-body text-muted-foreground">
                  <Link to="/admin/settings/shipping/areas" className="text-link hover:underline">{t("templateNeedsPlaces")}</Link>
                </p>
              ) : null}
            </section>
          ) : null}
          <ConfirmDialog
            open={template !== null}
            onOpenChange={(open) => !open && setTemplate(null)}
            title={t("templateConfirmTitle")}
            description={t("templateConfirmBody")}
            confirmLabel={t("templateUse")}
            cancelLabel={common("cancel")}
            variant="default"
            isLoading={applyTemplate.isPending}
            onConfirm={() => template && applyTemplate.mutate(template)}
          />
        </>
      }
    />
  );
}
