/** Store-default editing controls load inside the existing SettingsDialog/save scope. */
import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { getCountries, getCountryCallingCode } from "@scalius/shared/customer-utils";
import { SYSTEM_WEIGHT_UNITS, type UnitSystem, type WeightUnit } from "@scalius/shared/store-defaults";
import { getApiV1AdminSettingsStoreDefaults, postApiV1AdminSettingsStoreDefaults, putApiV1AdminSettingsAllowedCountries } from "@scalius/api-client/sdk";
import { Input } from "~/components/ui/input";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { apiData } from "~/lib/api";
import { storeDefaultsQueryOptions, type StoreDefaultsPayload } from "~/lib/api-query-options/store-defaults";
import { countriesQuery, platformQuery, type CountryPolicy } from "~/lib/api-query-options/settings-screens";
import { setStoreTimeZone } from "~/lib/store-time-zone";
import { timeZoneOptions } from "~/lib/time-zone-options";
import { queryKeys } from "~/lib/query-keys";
import { sortedUniqueStrings } from "~/lib/form-values";
import { getLocale, useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { storeSettingsMessages } from "~/i18n/settings-store";
import { SettingsField } from "./SettingsPage";

type Country = CountryPolicy["allowedCountries"][number];
type CountryMode = CountryPolicy["allowedCountriesMode"];
const storeDefaultsQuery = storeDefaultsQueryOptions();
const useCanEditStore = () => useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);

const STORE_DEFAULTS_FALLBACK: StoreDefaultsPayload = { timeZone: "Asia/Dhaka", unitSystem: "metric", weightUnit: "g", revision: 0, countryCode: "BD" };

function useStoreDefaultsForm() {
  const common = useMessages(settingsMessages);
  return useSettingsForm<StoreDefaultsPayload>({
    queryKey: storeDefaultsQuery.queryKey,
    fetchFn: () => apiData(getApiV1AdminSettingsStoreDefaults()),
    saveFn: async (draft, expectedRevision) => {
      const saved = await apiData(postApiV1AdminSettingsStoreDefaults({
        body: { expectedRevision, timeZone: draft.timeZone, unitSystem: draft.unitSystem, weightUnit: draft.weightUnit },
      }));
      setStoreTimeZone(saved.timeZone);
      // The country is Settings → Markets'; this card leaves it as read.
      return { ...saved, countryCode: draft.countryCode };
    },
    defaultValues: STORE_DEFAULTS_FALLBACK,
    // The platform document holds them: the web addresses card reloads its revision.
    invalidateQueryKeys: [platformQuery.queryKey, queryKeys.settings.storefrontUrl()],
    errorMessage: common("saveFailed"),
    canEdit: useCanEditStore(),
  });
}

export function TimeZoneFields() {
  const t = useMessages(storeSettingsMessages);
  const { values, setValue } = useStoreDefaultsForm();
  const options = useMemo(() => timeZoneOptions(values.timeZone, getLocale()), [values.timeZone]);
  return (
    <SettingsField id="store-time-zone" label={t("timeZoneRow")} help={t("timeZoneHelp")}>
      <SearchableSelect
        id="store-time-zone"
        value={values.timeZone}
        options={options}
        searchPlaceholder={t("timeZoneSearch")}
        emptyMessage={t("timeZoneNone")}
        triggerClassName="w-full"
        onValueChange={(zone) => setValue("timeZone", zone)}
      />
    </SettingsField>
  );
}

export function UnitFields() {
  const t = useMessages(storeSettingsMessages);
  const { values, setValues } = useStoreDefaultsForm();
  const units = SYSTEM_WEIGHT_UNITS[values.unitSystem];
  return (
    <>
      <SettingsField id="store-unit-system" label={t("unitSystemRow")}>
        <RadioGroup
          id="store-unit-system"
          value={values.unitSystem}
          onValueChange={(system) => setValues((draft) => ({
            ...draft,
            unitSystem: system as UnitSystem,
            // A new system starts at its default unit, as in Shopify.
            weightUnit: system === draft.unitSystem ? draft.weightUnit : SYSTEM_WEIGHT_UNITS[system as UnitSystem][0]!,
          }))}
        >
          {(["metric", "imperial"] as const).map((system) => (
            <label key={system} className="flex min-h-11 items-center gap-2 text-body md:min-h-9">
              <RadioGroupItem value={system} />
              {t(system)}
            </label>
          ))}
        </RadioGroup>
      </SettingsField>
      <SettingsField id="store-weight-unit" label={t("weightUnitRow")} help={t("unitsHelp")}>
        <SearchableSelect
          id="store-weight-unit"
          value={values.weightUnit}
          options={units.map((unit) => ({ value: unit, label: t(`unit_${unit}`) }))}
          triggerClassName="w-full"
          onValueChange={(unit) => setValues((draft) => ({ ...draft, weightUnit: unit as WeightUnit }))}
        />
      </SettingsField>
    </>
  );
}

// ── Customer countries ──────────────────────────────────────────────────

function countryName(code: string): string {
  try {
    return new Intl.DisplayNames([getLocale() === "bn" ? "bn" : "en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function CountryFields() {
  const t = useMessages(storeSettingsMessages);
  const common = useMessages(settingsMessages);
  const [search, setSearch] = useState("");
  const { values, setValue } = useSettingsForm<CountryPolicy>({
    queryKey: countriesQuery.queryKey,
    fetchFn: countriesQuery.queryFn,
    saveFn: (draft, expectedRevision) =>
      apiData(putApiV1AdminSettingsAllowedCountries({
        body: { allowedCountries: draft.allowedCountries, mode: draft.allowedCountriesMode, expectedRevision },
      })),
    invalidateQueryKeys: [queryKeys.settings.checkoutReadiness()],
    defaultValues: { allowedCountries: [], allowedCountriesMode: "include" },
    toDraft: (values) => ({ ...values, allowedCountries: sortedUniqueStrings(values.allowedCountries) }),
    errorMessage: common("saveFailed"),
    canEdit: useCanEditStore(),
  });
  const countries = useMemo(
    () =>
      getCountries()
        .map((code) => ({ code, name: countryName(code), callingCode: getCountryCallingCode(code) }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    [],
  );
  const needle = search.trim().toLocaleLowerCase();
  const matches = countries.filter(
    (country) =>
      !needle ||
      country.name.toLocaleLowerCase().includes(needle) ||
      country.code.toLowerCase().includes(needle) ||
      `+${country.callingCode}`.includes(needle),
  );
  const selected = values.allowedCountries;
  const toggle = (code: Country) =>
    setValue(
      "allowedCountries",
      selected.includes(code) ? selected.filter((item) => item !== code) : sortedUniqueStrings([...selected, code]),
    );

  return (
    <>
      <p className="text-body text-muted-foreground">{t("countriesHelp")}</p>
      <RadioGroup
        value={values.allowedCountriesMode}
        onValueChange={(mode) => setValue("allowedCountriesMode", mode as CountryMode)}
      >
        {(["include", "exclude"] as const).map((mode) => (
          <label key={mode} className="flex min-h-11 items-start gap-2 py-3 text-body">
            <span className="flex h-lh items-center"><RadioGroupItem value={mode} /></span>
            {mode === "include" ? t("onlySelected") : t("allExceptSelected")}
          </label>
        ))}
      </RadioGroup>
      {selected.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((code) => (
            <span key={code} className="inline-flex items-center gap-1 rounded-lg bg-secondary py-0.5 ps-2 pe-0.5 text-body text-secondary-foreground">
              {countryName(code)}
              <button
                type="button"
                aria-label={t("removeCountry", { country: countryName(code) })}
                className="grid size-8 place-items-center rounded-full hover:bg-muted-foreground/20 sm:size-6"
                onClick={() => toggle(code)}
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="relative">
        <Search className="pointer-events-none absolute inset-s-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          type="search"
          value={search}
          placeholder={t("countrySearch")}
          aria-label={t("countrySearch")}
          // eslint-disable-next-line shadcn/no-restyle -- room for the search icon inside the field
          className="ps-9"
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <div className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border">
        {matches.length === 0 ? (
          <p className="p-4 text-center text-body text-muted-foreground">{t("countryNone")}</p>
        ) : (
          matches.map((country) => (
            <label key={country.code} className="flex min-h-11 items-center gap-3 px-3 text-body hover:bg-muted/50">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={selected.includes(country.code)}
                onChange={() => toggle(country.code)}
              />
              <span className="flex-1">{country.name}</span>
              <span className="text-muted-foreground">+{country.callingCode}</span>
            </label>
          ))
        )}
      </div>
    </>
  );
}
