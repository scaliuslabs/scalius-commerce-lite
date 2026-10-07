import { Fragment, useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus, X } from "lucide-react";
import { toast } from "~/lib/toast";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useCurrency } from "~/hooks/use-currency";
import { useWholeUnitPrices } from "~/components/admin/shared/MoneyInput";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { apiClient, apiData } from "~/lib/api";
import {
  addressPlaceQuery,
  allDeliveryLocationsQueryOptions,
  deliveryLocationLoader,
  deliveryLocationsQueryOptions,
  type DeliveryLocation,
} from "~/lib/api-query-options/delivery";
import { parseAmountInput } from "~/lib/money-input";
import {
  ZONES_URL,
  areaCountsQuery,
  deliveryZonesQuery,
  type DeliveryZones,
} from "~/lib/api-query-options/settings-screens";
import { queryKeys } from "~/lib/query-keys";
import { addressCountriesQueryOptions, addressRulesQueryOptions } from "~/lib/api-query-options/address-rules";
import { countryName } from "~/lib/country-name";
import { CountryChecklist } from "~/components/admin/shared/CountryChecklist";
import { useMessages } from "~/i18n";
import { locationMessages } from "~/i18n/location";
import { settingsMessages } from "~/i18n/settings";
import { shippingMessages } from "~/i18n/settings-shipping";
import { cn } from "@scalius/shared/utils";
import { PLACE_ADDRESS_COUNTRY, deliveryHierarchyField } from "@scalius/shared/places";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { useSaveBar } from "../shared/SaveBar";
import { SettingsLoadFailure } from "./SettingsLoadFailure";
import { SettingsCard, SettingsCardLoading, SettingsDialog, SettingsField, SettingsRow } from "./SettingsPage";

type Zone = DeliveryZones["zones"][number];
type Rate = Zone["rates"][number];
type Place = Zone["locations"][number];
type Region = Zone["regions"][number];
type Kind = Rate["kind"];

/** Bangladesh: served whole, or by its City → Thana → Area delivery areas. */
const BD = "BD";

const json = { "Content-Type": "application/json" };
const send = (method: "post" | "put" | "delete", url: string, body?: unknown) =>
  apiData(apiClient[method]({ url, headers: json, ...(body === undefined ? {} : { body }) }));

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

function emptyDraft(kind: Kind = "delivery"): RateDraft {
  return {
    key: crypto.randomUUID(),
    id: null,
    kind,
    name: "",
    // Pickup is usually free: a new pickup charge starts at 0.
    fee: kind === "pickup" ? "0" : "",
    freeOver: "",
    description: "",
    pickupAddress: "",
    pickupHours: "",
    isActive: true,
  };
}

type RateErrorKey = "rateNameRequired" | "feeInvalid" | "feeTooHigh" | "freeOverTooHigh" | "pickupAddressRequired" | "wholeTaka";

/** A charge as typed; an empty pickup charge means free pickup. */
function feeOf(rate: RateDraft): number | null {
  return rate.kind === "pickup" && !rate.fee.trim() ? 0 : parseAmountInput(rate.fee);
}

/**
 * What's wrong with each field of a charge, or nothing. `wholeTaka`: the
 * store prices in whole units (Settings → Store details; a BDT store's
 * default), so a charge or threshold has no paisa.
 */
export function rateErrors(
  rate: RateDraft,
  wholeTaka = false,
): Partial<Record<"name" | "fee" | "freeOver" | "pickupAddress", RateErrorKey>> {
  const fee = feeOf(rate);
  const freeOver = rate.freeOver.trim() ? parseAmountInput(rate.freeOver) : null;
  const fractional = (amount: number) => wholeTaka && !Number.isInteger(amount);
  return {
    ...(rate.name.trim() ? {} : { name: "rateNameRequired" as const }),
    ...(fee === null
      ? { fee: "feeInvalid" as const }
      : fee > MAX_AMOUNT ? { fee: "feeTooHigh" as const } : fractional(fee) ? { fee: "wholeTaka" as const } : {}),
    ...(rate.freeOver.trim() && freeOver === null
      ? { freeOver: "feeInvalid" as const }
      : freeOver !== null && freeOver > MAX_AMOUNT
        ? { freeOver: "freeOverTooHigh" as const }
        : freeOver !== null && fractional(freeOver) ? { freeOver: "wholeTaka" as const } : {}),
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
  if (path === "regions" || path.startsWith("regions.")) return "zone-regions";
  const match = /^rates\.(\d+)\.(\w+)$/.exec(path);
  return match ? `rate-${match[1]}-${match[2]}` : undefined;
}

function RatesEditor({
  rates,
  onChange,
  pickupOnly = false,
}: {
  rates: RateDraft[];
  onChange: (rates: RateDraft[]) => void;
  /** Local pickup's charges (pickup points); a zone's charges are deliveries. */
  pickupOnly?: boolean;
}) {
  const t = useMessages(shippingMessages);
  const { symbol } = useCurrency();
  const wholeTaka = useWholeUnitPrices();
  const update = (index: number, patch: Partial<RateDraft>) =>
    onChange(rates.map((rate, i) => (i === index ? { ...rate, ...patch } : rate)));
  return (
    <section className="space-y-4 border-t border-border pt-4">
      <h3 className="text-heading-sm">{t("charges")}</h3>
      {rates.map((rate, index) => {
        const errors = rateErrors(rate, wholeTaka);
        const id = (field: string) => `rate-${index}-${field}`;
        return (
          <fieldset key={rate.key} className="space-y-4 border-t border-border pt-4 first-of-type:border-t-0 first-of-type:pt-0">
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
                  inputMode={wholeTaka ? "numeric" : "decimal"}
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
                inputMode={wholeTaka ? "numeric" : "decimal"}
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
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...rates, emptyDraft(pickupOnly ? "pickup" : "delivery")])}>
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
    <li className={cn("flex min-h-11 items-center gap-2 pe-3", depth === 0 ? "ps-2" : depth === 1 ? "ps-8" : "ps-14")}>
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
  const areas = useQuery(deliveryLocationsQueryOptions({ ...addressPlaceQuery("area"), parentId: zoneId, limit: 500 }));
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
  const place = useMessages(locationMessages);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const cities = useQuery(allDeliveryLocationsQueryOptions({ type: "city" })).data?.locations ?? [];
  const zones = useQuery(allDeliveryLocationsQueryOptions({ type: "zone" })).data?.locations ?? [];
  const cityName = new Map(cities.map((city) => [city.id, city.name]));
  const zoneById = new Map(zones.map((zone) => [zone.id, zone]));
  // A zone holds Bangladesh places: City (level 1), Thana (2), Area (3).
  const fieldOf = (location: DeliveryLocation) => deliveryHierarchyField(location.level) ?? "area";
  const parentName = (location: DeliveryLocation): string | null => {
    if (location.parentPath?.length) return location.parentPath.join(", ");
    if (fieldOf(location) === "zone") return cityName.get(location.parentId ?? "") ?? null;
    if (fieldOf(location) !== "area") return null;
    const zone = zoneById.get(location.parentId ?? "");
    return zone ? [zone.name, cityName.get(zone.parentId ?? "")].filter(Boolean).join(", ") : null;
  };
  const chosen = new Set(selected.map((item) => item.id));
  const add = (location: DeliveryLocation) =>
    onChange([...selected, { id: location.id, name: location.name, type: fieldOf(location), parentName: parentName(location) }]);
  const toggle = (location: DeliveryLocation, checked: boolean) =>
    checked ? add(location) : onChange(selected.filter((item) => item.id !== location.id));
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
  const typeName = { city: place("typeCity"), zone: place("typeZone"), area: place("typeArea") } as const;
  // Found places, remembered so a pick can be added with its parents.
  const [found] = useState(() => new Map<string, DeliveryLocation>());

  return (
    <SettingsField id="zone-places" label={t("zonePlaces")} help={t("zonePlacesHelp")} error={error}>
      <div className="space-y-2">
        {selected.length ? (
          <ul className="flex flex-wrap gap-2" aria-label={t("placeCount", { count: selected.length })}>
            {selected.map((item) => (
              <li key={item.id} className="flex items-center gap-1 rounded-lg bg-secondary py-0.5 ps-2 text-body">
                {item.parentName ? `${item.name}, ${item.parentName}` : item.name}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("removePlace", { name: item.name })}
                  onClick={() => onChange(selected.filter((other) => other.id !== item.id))}
                >
                  <X aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {/* Any city, thana or area, searched on the server; picking one adds it. */}
        <SearchableSelect
          id="zone-places"
          value=""
          aria-describedby="zone-places-note"
          ariaLabel={t("searchPlaces")}
          placeholder={t("searchPlaces")}
          searchPlaceholder={t("searchPlaces")}
          emptyMessage={t("noPlaces")}
          triggerClassName="w-full"
          load={deliveryLocationLoader({
            country: PLACE_ADDRESS_COUNTRY,
            toOption: (location) => {
              found.set(location.id, location);
              const zone = taken.get(location.id);
              return {
                value: location.id,
                label: location.name,
                description: [typeName[fieldOf(location)], ...(location.parentPath ?? []), zone ? t("inZone", { zone }) : null]
                  .filter(Boolean)
                  .join(" · "),
                disabled: Boolean(zone),
              };
            },
          })}
          queryKey={[...queryKeys.settings.deliveryLocations(), "picker", "zone-places", [...taken.keys()].sort().join(",")]}
          onValueChange={(id) => {
            const location = found.get(id);
            if (location && !chosen.has(id) && !taken.has(id)) add(location);
          }}
        />
        <ul className="max-h-72 overflow-y-auto rounded-lg border border-border py-1">
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
        </ul>
      </div>
    </SettingsField>
  );
}

// ── Countries and regions (Shopify's zone countries) ───────────────────

/**
 * One chosen country of a zone: all of it, or part of it (some regions and
 * postal-code prefixes; Bangladesh: some delivery areas).
 */
export interface CountryDraft {
  code: string;
  whole: boolean;
  adminAreas: string[];
  /** As typed: prefixes separated by commas. */
  postalPrefixes: string;
}

/** The prefixes typed for a country, as the API takes them. */
function prefixesOf(country: CountryDraft): string[] {
  return [...new Set(country.postalPrefixes.split(/[\s,;]+/).map((value) => value.trim().toUpperCase()).filter(Boolean))];
}

/** A zone's countries as the editor shows them. */
export function countryDraftsOf(zone: Pick<Zone, "regions" | "locations"> | null): CountryDraft[] {
  const byCode = new Map<string, CountryDraft>();
  for (const region of zone?.regions ?? []) {
    const draft = byCode.get(region.countryCode) ?? { code: region.countryCode, whole: false, adminAreas: [], postalPrefixes: "" };
    if (region.adminArea) draft.adminAreas.push(region.adminArea);
    else if (region.postalPrefix) draft.postalPrefixes = draft.postalPrefixes ? `${draft.postalPrefixes}, ${region.postalPrefix}` : region.postalPrefix;
    else draft.whole = true;
    byCode.set(region.countryCode, draft);
  }
  if ((zone?.locations.length ?? 0) > 0 && !byCode.has(BD)) {
    byCode.set(BD, { code: BD, whole: false, adminAreas: [], postalPrefixes: "" });
  }
  return [...byCode.values()].sort((left, right) => left.code.localeCompare(right.code));
}

/** The regions and Bangladesh delivery areas the API takes for a zone. */
export function zoneRegionsBody(countries: readonly CountryDraft[], places: readonly Place[]) {
  const regions = countries.flatMap((country): Array<{ countryCode: string; adminArea?: string; postalPrefix?: string }> => {
    if (country.whole) return [{ countryCode: country.code }];
    if (country.code === BD) return [];
    return [
      ...country.adminAreas.map((adminArea) => ({ countryCode: country.code, adminArea })),
      ...prefixesOf(country).map((postalPrefix) => ({ countryCode: country.code, postalPrefix })),
    ];
  });
  const bangladeshPart = countries.some((country) => country.code === BD && !country.whole);
  return { regions, locationIds: bangladeshPart ? places.map((place) => place.id) : [] };
}

/** What a chosen country still needs, or null. */
export function countryIssue(country: CountryDraft, places: readonly Place[]): "partRequired" | "placesRequiredFor" | null {
  if (country.whole) return null;
  if (country.code === BD) return places.length > 0 ? null : "placesRequiredFor";
  return country.adminAreas.length > 0 || prefixesOf(country).length > 0 ? null : "partRequired";
}

/** "Bangladesh: Dhaka, Mirpur", "United States: CA, postal codes 941", "France". */
function regionSummary(zone: Zone, t: ReturnType<typeof useMessages<keyof typeof shippingMessages.en>>): string {
  return countryDraftsOf(zone).map((country) => {
    const name = countryName(country.code);
    if (country.whole) return name;
    const parts = country.code === BD
      ? zone.locations.length <= 2 ? zone.locations.map((place) => place.name) : [t("placeCount", { count: zone.locations.length })]
      : [...country.adminAreas, ...(prefixesOf(country).length ? [t("postalSummary", { prefixes: prefixesOf(country).join(", ") })] : [])];
    return `${name}: ${parts.join(", ")}`;
  }).join(" · ") || t("noPlacesInZone");
}

/** One country's admin areas to choose from (its address rules), each held by at most one zone. */
function RegionChecklist({
  country,
  selected,
  taken,
  onChange,
}: {
  country: string;
  selected: readonly string[];
  /** `${country}|${code}` → the zone that holds it. */
  taken: ReadonlyMap<string, string>;
  onChange: (adminAreas: string[]) => void;
}) {
  const t = useMessages(shippingMessages);
  const rules = useQuery(addressRulesQueryOptions(country));
  const areas = rules.data?.adminAreas ?? [];
  if (rules.isPending) return <p className="text-body text-muted-foreground">{t("loadingRegions")}</p>;
  if (areas.length === 0) return null;
  const id = `zone-regions-${country}`;
  return (
    <fieldset className="space-y-2">
      <legend className="text-body font-medium">{t("regions")}</legend>
      <div id={id} className="h-48 divide-y divide-border overflow-y-auto rounded-lg border border-border">
        {areas.map((area) => {
          const zone = taken.get(`${country}|${area.code}`);
          return (
            <label key={area.code} className="flex min-h-11 items-center gap-3 px-3 text-body hover:bg-muted/50">
              <Checkbox
                checked={selected.includes(area.code)}
                disabled={Boolean(zone)}
                onCheckedChange={(checked) =>
                  onChange(checked === true ? [...selected, area.code] : selected.filter((code) => code !== area.code))}
              />
              <span className="min-w-0 flex-1 truncate">{area.name}</span>
              {zone ? <span className="shrink-0 text-muted-foreground">{t("inZone", { zone })}</span> : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** How much of one chosen country the zone serves. */
function CountryScope({
  country,
  places,
  takenWhole,
  takenAreas,
  takenPlaces,
  onChange,
  onPlaces,
}: {
  country: CountryDraft;
  places: Place[];
  /** Another zone holds the whole country: this one can serve only part of it. */
  takenWhole: string | undefined;
  takenAreas: ReadonlyMap<string, string>;
  takenPlaces: Map<string, string>;
  onChange: (country: CountryDraft) => void;
  onPlaces: (places: Place[]) => void;
}) {
  const t = useMessages(shippingMessages);
  const name = countryName(country.code);
  const id = `zone-scope-${country.code}`;
  const issue = countryIssue(country, places);
  return (
    <section aria-labelledby={`${id}-title`} className="space-y-3 border-t border-border pt-4">
      <h4 id={`${id}-title`} className="text-body font-medium">{name}</h4>
      <RadioGroup
        id={id}
        value={country.whole ? "whole" : "part"}
        onValueChange={(value) => onChange({ ...country, whole: value === "whole" })}
      >
        <label className="flex min-h-11 items-center gap-2 text-body">
          <RadioGroupItem value="whole" disabled={Boolean(takenWhole) && !country.whole} />
          {t("wholeCountry", { country: name })}
          {takenWhole ? <span className="text-muted-foreground">{t("inZone", { zone: takenWhole })}</span> : null}
        </label>
        <label className="flex min-h-11 items-center gap-2 text-body">
          <RadioGroupItem value="part" />
          {country.code === BD ? t("someDeliveryAreas") : t("partOfCountry", { country: name })}
        </label>
      </RadioGroup>
      {country.whole ? null : country.code === BD ? (
        <PlacePicker
          selected={places}
          taken={takenPlaces}
          error={issue ? t("placesRequiredFor", { country: name }) : null}
          onChange={onPlaces}
        />
      ) : (
        <>
          <RegionChecklist
            country={country.code}
            selected={country.adminAreas}
            taken={takenAreas}
            onChange={(adminAreas) => onChange({ ...country, adminAreas })}
          />
          <SettingsField
            id={`${id}-postal`}
            label={t("postalPrefixes")}
            help={t("postalPrefixesHelp")}
            error={issue ? t("partRequired", { country: name }) : null}
          >
            <Input
              id={`${id}-postal`}
              value={country.postalPrefixes}
              autoComplete="off"
              inputMode="text"
              aria-describedby={`${id}-postal-note`}
              onChange={(event) => onChange({ ...country, postalPrefixes: event.target.value })}
            />
          </SettingsField>
        </>
      )}
    </section>
  );
}

// ── The zone and local pickup forms ────────────────────────────────────

function ZoneForm({ zone, zones }: { zone: Zone | null; zones: Zone[] }) {
  const t = useMessages(shippingMessages);
  const common = useMessages(settingsMessages);
  const refresh = useRefreshZones();
  const onConflict = useConflictReload();
  const wholeTaka = useWholeUnitPrices();
  const countryList = useQuery(addressCountriesQueryOptions()).data;
  const [saved] = useState(() => ({
    name: zone?.name ?? "",
    countries: countryDraftsOf(zone),
    places: zone?.locations ?? [],
    rates: zone ? zone.rates.map(toDraft) : [emptyDraft()],
  }));
  const [draft, setDraft] = useState(saved);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const others = zones.filter((other) => other.id !== zone?.id);
  const taken = useMemo(() => {
    const places = new Map(others.flatMap((other) => other.locations.map((place) => [place.id, other.name] as const)));
    const whole = new Map<string, string>();
    const areas = new Map<string, string>();
    for (const other of others) {
      for (const region of other.regions as Region[]) {
        if (region.adminArea) areas.set(`${region.countryCode}|${region.adminArea}`, other.name);
        else if (!region.postalPrefix) whole.set(region.countryCode, other.name);
      }
    }
    return { places, whole, areas };
  }, [others]);
  const countryNotes = useMemo(
    () => new Map([...taken.whole].map(([code, name]) => [code, t("inZone", { zone: name })])),
    [taken.whole, t],
  );
  const body = () => ({
    name: draft.name.trim(),
    ...zoneRegionsBody(draft.countries, draft.places),
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
  const setCountries = (codes: string[]) =>
    setDraft((current) => ({
      ...current,
      countries: codes.map((code) => current.countries.find((country) => country.code === code)
        // A country another zone holds whole starts as part of it.
        ?? { code, whole: !taken.whole.has(code), adminAreas: [], postalPrefixes: "" }),
      places: codes.includes(BD) ? current.places : [],
    }));
  useSaveBar({
    fields: fieldId,
    dirty: JSON.stringify(draft) !== JSON.stringify(saved),
    saving: save.isPending,
    invalid: !draft.name.trim()
      || draft.countries.length === 0
      || draft.countries.some((country) => countryIssue(country, draft.places) !== null)
      || draft.rates.some((rate) => Object.keys(rateErrors(rate, wholeTaka)).length > 0),
    save: () => save.mutateAsync(),
    discard: () => setDraft(saved),
  });
  return (
    <>
      <SettingsField id="zone-name" label={t("zoneName")} error={draft.name.trim() ? null : t("zoneNameRequired")}>
        <Input id="zone-name" value={draft.name} maxLength={100} placeholder={t("zoneNamePlaceholder")} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
      </SettingsField>
      <SettingsField
        id="zone-regions"
        label={t("zoneRegions")}
        help={t("zoneRegionsHelp")}
        error={draft.countries.length ? null : t("zoneRegionsRequired")}
      >
        <CountryChecklist
          id="zone-regions"
          countries={countryList ?? [...new Set([BD, ...draft.countries.map((country) => country.code)])]}
          selected={draft.countries.map((country) => country.code)}
          notes={countryNotes}
          describedBy="zone-regions-note"
          copy={{
            search: t("countrySearch"),
            none: t("countryNone"),
            noneSelected: t("countryNoneSelected"),
            remove: (country) => t("removeCountry", { country }),
          }}
          onChange={setCountries}
        />
      </SettingsField>
      {draft.countries.map((country) => (
        <CountryScope
          key={country.code}
          country={country}
          places={draft.places}
          takenWhole={taken.whole.get(country.code)}
          takenAreas={taken.areas}
          takenPlaces={taken.places}
          onChange={(next) => setDraft((current) => ({
            ...current,
            countries: current.countries.map((entry) => (entry.code === next.code ? next : entry)),
            places: next.code === BD && next.whole ? [] : current.places,
          }))}
          onPlaces={(places) => setDraft((current) => ({ ...current, places }))}
        />
      ))}
      <RatesEditor rates={draft.rates} onChange={(rates) => setDraft({ ...draft, rates })} />
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

function PickupForm({ pickup }: { pickup: DeliveryZones["pickup"] }) {
  const refresh = useRefreshZones();
  const wholeTaka = useWholeUnitPrices();
  const onConflict = useConflictReload();
  const [saved] = useState(() => pickup.rates.map(toDraft));
  const [rates, setRates] = useState(saved);
  const save = useMutation({
    mutationFn: () =>
      send("put", `${ZONES_URL}/pickup`, { rates: rates.map(toRateInput), expectedRevision: pickup.revision }),
    onSuccess: refresh,
    onError: onConflict,
  });
  useSaveBar({
    fields: fieldId,
    dirty: JSON.stringify(rates) !== JSON.stringify(saved),
    saving: save.isPending,
    invalid: rates.some((rate) => Object.keys(rateErrors(rate, wholeTaka)).length > 0),
    save: () => save.mutateAsync(),
    discard: () => setRates(saved),
  });
  // Every charge here is a pickup point.
  return <RatesEditor rates={rates} pickupOnly onChange={setRates} />;
}

// ── The cards ──────────────────────────────────────────────────────────

const TEMPLATES = [
  { id: "dhaka_two_zone", title: "templateTwo", value: "templateTwoValue", inside: 60 },
  { id: "dhaka_three_zone", title: "templateThree", value: "templateThreeValue", inside: 70 },
] as const;

function useRateSummary() {
  const t = useMessages(shippingMessages);
  const { fmt } = useCurrency();
  return (rates: Rate[]) =>
    rates.length === 0
      ? t("noCharges")
      : rates.map((rate) => [
          rate.name,
          rate.fee === 0 ? t("free") : fmt(rate.fee),
          rate.freeOver === null ? null : t("freeOverSummary", { amount: fmt(rate.freeOver) }),
          rate.isActive ? null : t("off"),
        ].filter(Boolean).join(" ")).join(" · ");
}

export function DeliveryZonesCard() {
  const t = useMessages(shippingMessages);
  const common = useMessages(settingsMessages);
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_SHIPPING_METHODS_EDIT);
  const canView = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_SHIPPING_METHODS_VIEW);
  const { fmt } = useCurrency();
  const refresh = useRefreshZones();
  const summary = useRateSummary();
  const { data, isError, refetch } = useQuery({ ...deliveryZonesQuery, enabled: canView });
  const canViewPlaces = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_VIEW);
  const placeCounts = useQuery({ ...areaCountsQuery, enabled: canViewPlaces }).data;
  const hasPlaces = placeCounts ? placeCounts.cities > 0 : true;
  const [template, setTemplate] = useState<(typeof TEMPLATES)[number]["id"] | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const applyTemplate = useMutation({
    mutationFn: (id: string) => send("put", `${ZONES_URL}/template`, { template: id }),
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
              <SettingsRow disabled={!canEdit} label={zone.name} value={`${regionSummary(zone, t)} · ${summary(zone.rates)}`} />
            }>
              <ZoneForm zone={zone} zones={data.zones} />
            </SettingsDialog>
          ))}
          {data.zones.length === 0 && canEdit ? (
            // Suggestions, not zones: nothing here is live until the merchant uses one.
            <section aria-labelledby="suggested-setups" className="border-t border-border first:border-t-0">
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

/** Local pickup: store-wide, offered for every address (Shopify's local pickup). */
export function LocalPickupCard() {
  const t = useMessages(shippingMessages);
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_SHIPPING_METHODS_EDIT);
  const canView = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_SHIPPING_METHODS_VIEW);
  const summary = useRateSummary();
  const { data } = useQuery({ ...deliveryZonesQuery, enabled: canView });
  if (!canView || !data) return null;
  return (
    <SettingsCard
      id="localPickup"
      title={t("pickupTitle")}
      description={t("pickupDescription")}
      rows={
        <SettingsDialog title={t("editPickup")} description={t("pickupDescription")} trigger={
          <SettingsRow
            disabled={!canEdit}
            label={t("pickupTitle")}
            value={data.pickup.rates.length ? summary(data.pickup.rates) : t("noPickup")}
          />
        }>
          <PickupForm pickup={data.pickup} />
        </SettingsDialog>
      }
    />
  );
}
