import { lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatBdLandline } from "@scalius/shared/bd-landline";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { storeDefaultsQueryOptions } from "~/lib/api-query-options/store-defaults";
import { timeZoneLabel } from "~/lib/time-zone-options";
import {
  businessQuery,
  countriesQuery,
  currencyQuery,
  platformQuery,
} from "~/lib/api-query-options/settings-screens";
import { useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { storeSettingsMessages } from "~/i18n/settings-store";
import { SettingsLoadFailure } from "./SettingsLoadFailure";
import { SettingsCard, SettingsDialog, SettingsRow, SettingsCardLoading } from "./SettingsPage";
import { ADVANCED_URL_KEYS, MAIN_URL_KEYS, SettingsAdvanced, URL_LABELS, currencyName, useCanEditStore } from "./store-settings-shared";

const loadStoreDefaultsFields = () => import("./StoreDefaultsFields");
const TimeZoneFields = lazy(() => loadStoreDefaultsFields().then((module) => ({ default: module.TimeZoneFields })));
const UnitFields = lazy(() => loadStoreDefaultsFields().then((module) => ({ default: module.UnitFields })));
const CountryFields = lazy(() => loadStoreDefaultsFields().then((module) => ({ default: module.CountryFields })));

// The dialogs' fields (contact checks, the phone input, image pickers, the
// web-address check) load right after the page instead of with it; a dialog
// opened before they arrive shows a quiet placeholder.
const loadStoreFields = () => import("./StoreSettingsFields");
void loadStoreFields().catch(() => {});
const BusinessFields = lazy(() => loadStoreFields().then((module) => ({ default: module.BusinessFields })));
const InvoiceFields = lazy(() => loadStoreFields().then((module) => ({ default: module.InvoiceFields })));
const SocialProfileFields = lazy(() => loadStoreFields().then((module) => ({ default: module.SocialProfileFields })));
const WebAddressFields = lazy(() => loadStoreFields().then((module) => ({ default: module.WebAddressFields })));
const CurrencyFields = lazy(() => loadStoreFields().then((module) => ({ default: module.CurrencyFields })));
const fieldsFallback = <Skeleton className="h-32 w-full" />;

function joined(parts: Array<string | undefined>): string {
  return parts.map((part) => part?.trim()).filter(Boolean).join(", ");
}

// The missing-logo warning reads the theme, so its code loads after the page.
const StoreLogoNotice = lazy(() => import("./StoreLogoNotice").then((module) => ({ default: module.StoreLogoNotice })));

export function BusinessCard() {
  const t = useMessages(storeSettingsMessages);
  const canEdit = useCanEditStore();
  const { data, isError, refetch } = useQuery(businessQuery);
  if (isError) {
    return <SettingsLoadFailure title={t("loadBusiness")} onRetry={refetch} />;
  }
  if (!data) return <SettingsCardLoading />;
  const social = data.socialLinks ?? [];
  const socialNames = social.map((link) => link.label.trim()).filter(Boolean);
  const socialSummary = social.length === 0
    ? t("noSocial")
    : socialNames.length === social.length ? socialNames.join(", ") : t("socialCount", { count: social.length });
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
                  formatBdLandline(data.phone) || t("noPhone"),
                ].join(" · ")}
              />
            }
          >
            <Suspense fallback={fieldsFallback}>
              <BusinessFields
                fields={[
                  { key: "companyName", label: t("companyName") },
                  { key: "legalName", label: t("legalName"), help: t("legalNameHelp") },
                  { key: "email", label: t("email"), type: "email" },
                  { key: "phone", label: t("phone"), help: t("phoneHelp"), type: "tel" },
                  { key: "taxId", label: t("taxId") },
                ]}
              />
            </Suspense>
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
            <Suspense fallback={fieldsFallback}>
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
            </Suspense>
          </SettingsDialog>
          <SettingsDialog
            title={t("socialRow")}
            trigger={
              <SettingsRow
                label={t("socialRow")}
                disabled={!canEdit}
                value={socialSummary}
              />
            }
          >
            <Suspense fallback={fieldsFallback}>
              <SocialProfileFields />
            </Suspense>
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
            <Suspense fallback={fieldsFallback}>
              <InvoiceFields />
            </Suspense>
          </SettingsDialog>
        </>
      }
    >
      <Suspense fallback={null}>
        <StoreLogoNotice />
      </Suspense>
    </SettingsCard>
  );
}

// ── Web addresses (platform origins) ────────────────────────────────────

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
          <Suspense fallback={fieldsFallback}>
            <WebAddressFields />
          </Suspense>
        </SettingsDialog>
      }
    >
      <div className="flex flex-col gap-3">
        <dl className="grid gap-3 text-body sm:grid-cols-[10rem_minmax(0,1fr)]">
          {MAIN_URL_KEYS.map((key) => (
            <div key={key} className="contents">
              <dt className="text-muted-foreground">{t(URL_LABELS[key][0])}</dt>
              <dd className="-mt-2 truncate sm:mt-0">{data[key] || t("notSet")}</dd>
            </div>
          ))}
        </dl>
        <Suspense fallback={null}>
          <SettingsAdvanced label={t("advancedAddresses")}>
            <dl className="grid gap-3 text-body sm:grid-cols-[10rem_minmax(0,1fr)]">
              {ADVANCED_URL_KEYS.map((key) => (
                <div key={key} className="contents">
                  <dt className="text-muted-foreground">{t(URL_LABELS[key][0])}</dt>
                  <dd className="-mt-2 truncate sm:mt-0">{data[key] || t("notSet")}</dd>
                </div>
              ))}
            </dl>
          </SettingsAdvanced>
        </Suspense>
      </div>
    </SettingsCard>
  );
}

// ── Currency ────────────────────────────────────────────────────────────

// ── Time zone and units ─────────────────────────────────────────────────

const storeDefaultsQuery = storeDefaultsQueryOptions();

export function StoreDefaultsCard() {
  const t = useMessages(storeSettingsMessages);
  const canEdit = useCanEditStore();
  const currency = useQuery(currencyQuery);
  const countries = useQuery(countriesQuery);
  const defaults = useQuery(storeDefaultsQuery);
  if (currency.isError) {
    return <SettingsLoadFailure title={t("loadCurrency")} onRetry={currency.refetch} />;
  }
  if (!currency.data) return <SettingsCardLoading />;
  if (countries.isError) {
    return <SettingsLoadFailure title={t("loadCountries")} onRetry={countries.refetch} />;
  }
  if (!countries.data) return <SettingsCardLoading />;
  if (defaults.isError) {
    return <SettingsLoadFailure title={t("loadStoreDefaults")} onRetry={defaults.refetch} />;
  }
  if (!defaults.data) return <SettingsCardLoading />;
  const { allowedCountries, allowedCountriesMode } = countries.data;
  const code = currency.data.currencyCode;
  const { timeZone, unitSystem, weightUnit } = defaults.data;
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
            <Suspense fallback={fieldsFallback}>
              <CurrencyFields />
            </Suspense>
          </SettingsDialog>
          <SettingsDialog
            title={t("unitsTitle")}
            trigger={
              <SettingsRow
                label={t("unitSystemRow")}
                disabled={!canEdit}
                value={`${t(unitSystem)} · ${t(`unit_${weightUnit}`)}`}
              />
            }
          >
            <Suspense fallback={<Skeleton className="h-32 w-full" />}><UnitFields /></Suspense>
          </SettingsDialog>
          <SettingsDialog
            title={t("timeZoneTitle")}
            trigger={
              <SettingsRow
                label={t("timeZoneRow")}
                disabled={!canEdit}
                value={timeZoneLabel(timeZone)}
              />
            }
          >
            <Suspense fallback={<Skeleton className="h-32 w-full" />}><TimeZoneFields /></Suspense>
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
            <Suspense fallback={<Skeleton className="h-32 w-full" />}><CountryFields /></Suspense>
          </SettingsDialog>
        </>
      }
    />
  );
}