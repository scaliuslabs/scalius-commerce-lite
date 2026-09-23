import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ImageIcon, Search, X } from "lucide-react";
import { getCountries, getCountryCallingCode, type Country } from "react-phone-number-input";
import {
  getApiV1AdminSettingsAllowedCountries,
  getApiV1AdminSettingsBusiness,
  getApiV1AdminSettingsCurrency,
  getApiV1AdminSettingsPlatform,
  postApiV1AdminSettingsBusiness,
  postApiV1AdminSettingsCurrency,
  putApiV1AdminSettingsAllowedCountries,
  putApiV1AdminSettingsPlatform,
} from "@scalius/api-client/sdk";
import {
  SUPPORTED_CURRENCY_CODES,
  normalizeSupportedCurrencyCode,
} from "@scalius/shared/currency";
import { normalizePublicMediaUrl } from "@scalius/shared/media-url";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import {
  normalizeDashboardUrl,
  normalizeMediaBaseUrl,
  normalizePlatformOriginUrl,
} from "@scalius/shared/platform-config";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Textarea } from "~/components/ui/textarea";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { apiData, type ApiResult } from "~/lib/api";
import { normalizeCurrencySettingsInput, type CurrencySettingsPayload } from "~/lib/api-query-options/currency";
import { queryKeys } from "~/lib/query-keys";
import { getLocale, useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { storeSettingsMessages } from "~/i18n/settings-store";
import { MediaManager } from "../media-manager";
import { SettingsLoadFailure } from "./SettingsLoadFailure";
import { normalizeStorePhone } from "./store-phone";
import { SettingsCard, SettingsDialog, SettingsField, SettingsRow, SettingsCardLoading } from "./SettingsPage";

type Business = ApiResult<typeof getApiV1AdminSettingsBusiness>;
type Platform = ApiResult<typeof getApiV1AdminSettingsPlatform>;
type CountryMode = "include" | "exclude";
interface CountryPolicy {
  allowedCountries: Country[];
  allowedCountriesMode: CountryMode;
}

export const businessQuery = {
  queryKey: queryKeys.settings.business(),
  queryFn: () => apiData(getApiV1AdminSettingsBusiness()),
};
export const platformQuery = {
  queryKey: queryKeys.settings.platform(),
  queryFn: () => apiData(getApiV1AdminSettingsPlatform()),
};
export const currencyQuery = {
  queryKey: queryKeys.settings.currency(),
  queryFn: () => apiData(getApiV1AdminSettingsCurrency()),
};
export const countriesQuery = {
  queryKey: queryKeys.settings.allowedCountries(),
  queryFn: async (): Promise<CountryPolicy> => {
    const data = await apiData(getApiV1AdminSettingsAllowedCountries());
    return {
      allowedCountries: (Array.isArray(data.allowedCountries) ? data.allowedCountries : []) as Country[],
      allowedCountriesMode: data.allowedCountriesMode === "exclude" ? "exclude" : "include",
    };
  },
};

const BUSINESS_DEFAULTS: Business = {
  companyName: "",
  legalName: "",
  taxId: "",
  phone: "",
  email: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  stateRegion: "",
  postalCode: "",
  country: "Bangladesh",
  invoicePrefix: "INV",
  invoiceLogoUrl: "",
  invoiceFooterText: "",
};

function useCanEditStore() {
  return useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
}

function joined(parts: Array<string | undefined>): string {
  return parts.map((part) => part?.trim()).filter(Boolean).join(", ");
}

// ── Business details ────────────────────────────────────────────────────

function isValidLogo(value: string) {
  return !value.trim() || Boolean(normalizePublicMediaUrl(value));
}

function useBusinessForm() {
  const common = useMessages(settingsMessages);
  return useSettingsForm<Business>({
    queryKey: businessQuery.queryKey,
    fetchFn: businessQuery.queryFn,
    saveFn: (values) => apiData(postApiV1AdminSettingsBusiness({ body: values })),
    defaultValues: BUSINESS_DEFAULTS,
    errorMessage: common("saveFailed"),
    canEdit: useCanEditStore(),
    isValid: (values) => isValidLogo(values.invoiceLogoUrl),
    fields: (path) => `business-${path}`,
  });
}

type BusinessKey = Exclude<keyof Business, "invoiceLogoUrl" | "invoiceFooterText">;

function BusinessFields({ fields }: { fields: Array<{ key: BusinessKey; label: string; help?: string; type?: string }> }) {
  const { values, setValue } = useBusinessForm();
  return fields.map(({ key, label, help, type }) => (
    <SettingsField key={key} id={`business-${key}`} label={label} help={help}>
      <Input
        id={`business-${key}`}
        type={type}
        value={values[key]}
        inputMode={key === "phone" ? "tel" : undefined}
        aria-describedby={help ? `business-${key}-note` : undefined}
        onChange={(event) => setValue(key, event.target.value)}
        onBlur={key === "phone" ? () => setValue(key, normalizeStorePhone(values[key])) : undefined}
      />
    </SettingsField>
  ));
}

function InvoiceFields() {
  const t = useMessages(storeSettingsMessages);
  const common = useMessages(settingsMessages);
  const { values, setValue } = useBusinessForm();
  const logoUrl = values.invoiceLogoUrl.trim() ? normalizePublicMediaUrl(values.invoiceLogoUrl) : null;
  const prefix = values.invoicePrefix.trim() || "INV";
  return (
    <>
      <SettingsField
        id="business-invoicePrefix"
        label={t("invoicePrefix")}
        help={t("invoicePreview", { example: `${prefix}-00001` })}
      >
        <Input
          id="business-invoicePrefix"
          value={values.invoicePrefix}
          aria-describedby="business-invoicePrefix-note"
          className="max-w-xs"
          onChange={(event) => setValue("invoicePrefix", event.target.value)}
        />
      </SettingsField>
      <div className="space-y-1.5">
        <Label>{t("invoiceLogo")}</Label>
        <div className="flex items-center gap-3">
          <div className="grid h-16 w-32 shrink-0 place-items-center rounded-lg border border-border bg-muted p-2">
            {logoUrl ? (
              <img src={mediaImageUrl(logoUrl, 480)} alt="" className="max-h-12 max-w-full object-contain" />
            ) : (
              <ImageIcon className="size-5 text-muted-foreground" aria-label={t("noLogo")} />
            )}
          </div>
          <MediaManager
            capability="image"
            onSelect={(file) => setValue("invoiceLogoUrl", file.url)}
            trigger={
              <Button type="button" variant="outline">
                {logoUrl ? t("changeLogo") : t("chooseLogo")}
              </Button>
            }
          />
          {values.invoiceLogoUrl ? (
            <Button type="button" variant="ghost" onClick={() => setValue("invoiceLogoUrl", "")}>
              {common("remove")}
            </Button>
          ) : null}
        </div>
        {!isValidLogo(values.invoiceLogoUrl) ? (
          <p role="alert" className="text-body text-destructive">{t("logoUrlInvalid")}</p>
        ) : null}
      </div>
      <SettingsField id="business-invoiceFooterText" label={t("invoiceFooter")}>
        <Textarea
          id="business-invoiceFooterText"
          rows={3}
          value={values.invoiceFooterText}
          placeholder={t("invoiceFooterPlaceholder")}
          onChange={(event) => setValue("invoiceFooterText", event.target.value)}
        />
      </SettingsField>
    </>
  );
}

export function BusinessCard() {
  const t = useMessages(storeSettingsMessages);
  const canEdit = useCanEditStore();
  const { data, isError, refetch } = useQuery(businessQuery);
  if (isError) {
    return <SettingsLoadFailure title={t("loadBusiness")} onRetry={refetch} />;
  }
  if (!data) return <SettingsCardLoading />;
  return (
    <SettingsCard id="business"
      title={t("businessTitle")}
      rows={
        <>
          <SettingsDialog
            title={t("contactRow")}
            trigger={
              <SettingsRow
                label={t("contactRow")}
                disabled={!canEdit}
                value={[
                  data.companyName || t("noName"),
                  data.email || t("noEmail"),
                  data.phone || t("noPhone"),
                ].join(" · ")}
              />
            }
          >
            <BusinessFields
              fields={[
                { key: "companyName", label: t("companyName") },
                { key: "legalName", label: t("legalName"), help: t("legalNameHelp") },
                { key: "email", label: t("email"), type: "email" },
                { key: "phone", label: t("phone"), help: t("phoneHelp"), type: "tel" },
                { key: "taxId", label: t("taxId") },
              ]}
            />
          </SettingsDialog>
          <SettingsDialog
            title={t("addressRow")}
            trigger={
              <SettingsRow
                label={t("addressRow")}
                disabled={!canEdit}
                value={joined([data.addressLine1, data.addressLine2, data.city, data.postalCode, data.country]) || t("noAddress")}
              />
            }
          >
            <BusinessFields
              fields={[
                { key: "addressLine1", label: t("addressLine1") },
                { key: "addressLine2", label: t("addressLine2") },
                { key: "city", label: t("city") },
                { key: "stateRegion", label: t("region") },
                { key: "postalCode", label: t("postalCode") },
                { key: "country", label: t("country") },
              ]}
            />
          </SettingsDialog>
          <SettingsDialog
            title={t("invoiceRow")}
            trigger={
              <SettingsRow
                label={t("invoiceRow")}
                disabled={!canEdit}
                value={t("invoiceSummary", { prefix: data.invoicePrefix || "INV" })}
              />
            }
          >
            <InvoiceFields />
          </SettingsDialog>
        </>
      }
    />
  );
}

// ── Web addresses (platform origins) ────────────────────────────────────

const URL_KEYS = ["storefrontUrl", "dashboardUrl", "apiUrl", "mediaUrl"] as const;
type UrlKey = (typeof URL_KEYS)[number];

function urlError(key: UrlKey, raw: string): "urlRequired" | "urlInvalid" | "dashboardUrlInvalid" | null {
  const value = raw.trim();
  if (key === "storefrontUrl" && !value) return "urlRequired";
  if (!value) return null;
  if (key === "dashboardUrl") return normalizeDashboardUrl(value) ? null : "dashboardUrlInvalid";
  if (key === "mediaUrl") return normalizeMediaBaseUrl(value) ? null : "urlInvalid";
  return normalizePlatformOriginUrl(value) ? null : "urlInvalid";
}

const URL_LABELS = {
  storefrontUrl: ["storeUrl", "storeUrlHelp"],
  dashboardUrl: ["dashboardUrl", "dashboardUrlHelp"],
  apiUrl: ["apiUrl", "apiUrlHelp"],
  mediaUrl: ["mediaUrl", "mediaUrlHelp"],
} as const;

function WebAddressFields() {
  const t = useMessages(storeSettingsMessages);
  const common = useMessages(settingsMessages);
  const { values, setValue } = useSettingsForm<Platform, Platform>({
    queryKey: platformQuery.queryKey,
    fetchFn: platformQuery.queryFn,
    // PUT is a partial update: only the web addresses travel from this form.
    saveFn: (draft) =>
      apiData(putApiV1AdminSettingsPlatform({
        body: Object.fromEntries(URL_KEYS.map((key) => [key, draft[key].trim()])),
      })),
    resolveSavedValues: (payload) => payload,
    invalidateQueryKeys: [queryKeys.settings.storefrontUrl(), queryKeys.settings.security()],
    defaultValues: {} as Platform,
    errorMessage: common("saveFailed"),
    canEdit: useCanEditStore(),
    isValid: (draft) => URL_KEYS.every((key) => !urlError(key, draft[key] ?? "")),
    fields: (path) => `platform-${path}`,
  });
  return URL_KEYS.map((key) => {
    const [label, help] = URL_LABELS[key];
    const error = urlError(key, values[key] ?? "");
    return (
      <SettingsField key={key} id={`platform-${key}`} label={t(label)} help={t(help)} error={error ? t(error) : null}>
        <Input
          id={`platform-${key}`}
          type="url"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="https://"
          value={values[key] ?? ""}
          aria-invalid={Boolean(error)}
          aria-describedby={`platform-${key}-note`}
         
          onChange={(event) => setValue(key, event.target.value)}
        />
      </SettingsField>
    );
  });
}

export function WebAddressesCard() {
  const t = useMessages(storeSettingsMessages);
  const common = useMessages(settingsMessages);
  const canEdit = useCanEditStore();
  const { data, isError, refetch } = useQuery(platformQuery);
  if (isError) {
    return <SettingsLoadFailure title={t("loadAddresses")} onRetry={refetch} />;
  }
  if (!data) return <SettingsCardLoading />;
  return (
    <SettingsCard id="webAddresses"
      title={t("addressesTitle")}
      description={data.readiness.status === "ready" ? t("addressesDescription") : t("addressesMissing")}
      action={
        <SettingsDialog
          title={t("addressesTitle")}
          trigger={
            <Button type="button" variant="outline" size="sm" disabled={!canEdit}>
              {common("edit")}
            </Button>
          }
        >
          <WebAddressFields />
        </SettingsDialog>
      }
    >
      <dl className="grid gap-3 text-body sm:grid-cols-[10rem_minmax(0,1fr)]">
        {URL_KEYS.map((key) => (
          <div key={key} className="contents">
            <dt className="text-muted-foreground">{t(URL_LABELS[key][0])}</dt>
            <dd className="-mt-2 truncate sm:mt-0">{data[key] || t("notSet")}</dd>
          </div>
        ))}
      </dl>
    </SettingsCard>
  );
}

// ── Currency ────────────────────────────────────────────────────────────

function currencyName(code: string): string {
  try {
    return new Intl.DisplayNames([getLocale() === "bn" ? "bn" : "en"], { type: "currency" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function currencySymbol(code: string): string {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: code, currencyDisplay: "narrowSymbol" })
      .formatToParts(0)
      .find((part) => part.type === "currency")?.value ?? code;
  } catch {
    return code;
  }
}

export function isValidUsdExchangeRate(value: string): boolean {
  const trimmed = value.trim();
  const rate = Number(trimmed);
  return trimmed.length > 0 && Number.isFinite(rate) && rate > 0;
}

function CurrencyFields() {
  const t = useMessages(storeSettingsMessages);
  const common = useMessages(settingsMessages);
  const { values, setValues, setValue } = useSettingsForm<CurrencySettingsPayload>({
    queryKey: currencyQuery.queryKey,
    fetchFn: currencyQuery.queryFn,
    saveFn: (draft) =>
      apiData(postApiV1AdminSettingsCurrency({
        body: normalizeCurrencySettingsInput({
          currencyCode: draft.currencyCode,
          currencySymbol: draft.currencySymbol,
          usdExchangeRate: draft.usdExchangeRate,
        }),
      })),
    defaultValues: { currencyCode: "BDT", currencySymbol: "৳", usdExchangeRate: "1", currencyCodeLocked: false },
    errorMessage: common("saveFailed"),
    canEdit: useCanEditStore(),
    isValid: (draft) => isValidUsdExchangeRate(draft.usdExchangeRate),
  });
  const options = useMemo(
    () =>
      SUPPORTED_CURRENCY_CODES.map((code) => ({
        value: code,
        label: `${currencyName(code)} (${code} ${currencySymbol(code)})`,
        keywords: [code],
      })),
    [],
  );
  const rateValid = isValidUsdExchangeRate(values.usdExchangeRate);
  return (
    <>
      <SettingsField
        id="currency-code"
        label={t("currencyRow")}
        help={values.currencyCodeLocked ? t("currencyLocked") : t("currencyLockWarning")}
      >
        <SearchableSelect
          id="currency-code"
          value={values.currencyCode}
          options={options}
          disabled={values.currencyCodeLocked}
          searchPlaceholder={t("currencySearch")}
          emptyMessage={t("currencyNone")}
          triggerClassName="w-full"
          onValueChange={(code) => {
            const supported = normalizeSupportedCurrencyCode(code);
            if (supported) setValues((draft) => ({ ...draft, currencyCode: supported, currencySymbol: currencySymbol(supported) }));
          }}
        />
      </SettingsField>
      <SettingsField id="currency-symbol" label={t("currencySymbol")}>
        <Input
          id="currency-symbol"
          value={values.currencySymbol}
          className="max-w-40"
          onChange={(event) => setValue("currencySymbol", event.target.value)}
        />
      </SettingsField>
      <SettingsField
        id="currency-usd-rate"
        label={t("usdRate")}
        help={t("usdRateHelp", { code: values.currencyCode })}
        error={rateValid ? null : t("usdRateInvalid")}
      >
        <Input
          id="currency-usd-rate"
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          value={values.usdExchangeRate}
          aria-invalid={!rateValid}
          aria-describedby="currency-usd-rate-note"
          className="max-w-40"
          onChange={(event) => setValue("usdExchangeRate", event.target.value)}
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

function CountryFields() {
  const t = useMessages(storeSettingsMessages);
  const common = useMessages(settingsMessages);
  const [search, setSearch] = useState("");
  const { values, setValue } = useSettingsForm<CountryPolicy>({
    queryKey: countriesQuery.queryKey,
    fetchFn: countriesQuery.queryFn,
    saveFn: async (draft) => {
      await apiData(putApiV1AdminSettingsAllowedCountries({
        body: { allowedCountries: draft.allowedCountries, mode: draft.allowedCountriesMode },
      }));
    },
    invalidateQueryKeys: [queryKeys.settings.checkoutReadiness()],
    defaultValues: { allowedCountries: [], allowedCountriesMode: "include" },
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
      selected.includes(code) ? selected.filter((item) => item !== code) : [...selected, code],
    );

  return (
    <>
      <RadioGroup
        value={values.allowedCountriesMode}
        onValueChange={(mode) => setValue("allowedCountriesMode", mode as CountryMode)}
      >
        {(["include", "exclude"] as const).map((mode) => (
          <label key={mode} className="flex min-h-11 items-start gap-2 py-3 text-body">
            <RadioGroupItem className="mt-0.5" value={mode} />
            {mode === "include" ? t("onlySelected") : t("allExceptSelected")}
          </label>
        ))}
      </RadioGroup>
      {selected.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((code) => (
            <span key={code} className="inline-flex items-center gap-1 rounded-lg bg-secondary py-0.5 pl-2 pr-0.5 text-body text-secondary-foreground">
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
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          type="search"
          value={search}
          placeholder={t("countrySearch")}
          aria-label={t("countrySearch")}
          // eslint-disable-next-line shadcn/no-restyle -- room for the search icon inside the field
          className="pl-9"
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

export function StoreDefaultsCard() {
  const t = useMessages(storeSettingsMessages);
  const canEdit = useCanEditStore();
  const currency = useQuery(currencyQuery);
  const countries = useQuery(countriesQuery);
  if (currency.isError) {
    return <SettingsLoadFailure title={t("loadCurrency")} onRetry={currency.refetch} />;
  }
  if (!currency.data) return <SettingsCardLoading />;
  if (countries.isError) {
    return <SettingsLoadFailure title={t("loadCountries")} onRetry={countries.refetch} />;
  }
  if (!countries.data) return <SettingsCardLoading />;
  const { allowedCountries, allowedCountriesMode } = countries.data;
  const code = currency.data.currencyCode;
  return (
    <SettingsCard id="storeDefaults"
      title={t("defaultsTitle")}
      rows={
        <>
          <SettingsDialog
            title={t("currencyTitle")}
            trigger={
              <SettingsRow
                label={t("currencyRow")}
                disabled={!canEdit}
                value={`${currencyName(code)} (${code} ${currency.data.currencySymbol})`}
              />
            }
          >
            <CurrencyFields />
          </SettingsDialog>
          <SettingsDialog
            title={t("countriesTitle")}
            trigger={
              <SettingsRow
                label={t("countriesRow")}
                disabled={!canEdit}
                value={
                  allowedCountries.length === 0
                    ? t("allCountries")
                    : allowedCountriesMode === "include"
                      ? t("onlyCountries", { count: allowedCountries.length })
                      : t("exceptCountries", { count: allowedCountries.length })
                }
              />
            }
          >
            <CountryFields />
          </SettingsDialog>
        </>
      }
    />
  );
}
