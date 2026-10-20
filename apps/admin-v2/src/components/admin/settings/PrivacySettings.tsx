// Settings → Customer privacy: the cookie banner (one choice for the markets
// outside Europe, the UK and Switzerland, which always ask first) and what
// customers allowed on the last day's orders, with the details ad platforms
// match on behind "Details". Each destination's tag, sales and test mode live
// in its own card in Integrations (TrackingDestinations).
import { lazy, Suspense, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { postApiV1AdminSettingsTracking } from "@scalius/api-client/sdk";
import { CONSENT_REGIMES, consentRegimeFor, type ConsentRegime } from "@scalius/shared/tracking-consent";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { apiData } from "~/lib/api";
import { marketsQueryOptions } from "~/lib/api-query-options/markets";
import { formatNumber, useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { settingsPrivacyMessages, type SettingsPrivacyMessageKey } from "~/i18n/settings-privacy";
import { SettingsLoadFailure } from "./SettingsLoadFailure";
import { SettingsCard, SettingsCardLoading } from "./SettingsPage";
import {
  PRIVACY_DEFAULTS,
  loadedFrom,
  trackingHealthQuery,
  trackingSaveBody,
  trackingSettingsQuery,
  type Loaded,
  type PrivacyValues,
  type Revisions,
} from "./tracking-settings";

export { trackingHealthQuery, trackingSettingsQuery } from "./tracking-settings";

const SettingsAdvanced = lazy(() => import("./SettingsAdvanced").then((module) => ({ default: module.SettingsAdvanced })));

const REGIME_LABEL: Record<ConsentRegime, SettingsPrivacyMessageKey> = {
  notice: "marketTells",
  opt_in: "marketAsks",
  link_only: "marketLinkOnly",
};

/** A market that sells where the law asks first (a market naming no country sells everywhere). */
function sellsWhereLawAsks(countries: readonly string[]): boolean {
  return countries.length === 0 || consentRegimeFor(countries, { otherRegions: "notice" }) === "opt_in";
}

/** The banner's choice, saved with the page (only the consent section travels). */
export function CookieBannerCard() {
  const t = useMessages(settingsPrivacyMessages);
  const common = useMessages(settingsMessages);
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.ANALYTICS_EDIT);
  const markets = useQuery(marketsQueryOptions());
  const savedRef = useRef<PrivacyValues>(PRIVACY_DEFAULTS);
  const form = useSettingsForm<PrivacyValues, Loaded, Revisions>({
    label: t("bannerTitle"),
    queryKey: trackingSettingsQuery.queryKey,
    fetchFn: trackingSettingsQuery.queryFn,
    saveFn: async (values, revision) => {
      const body = trackingSaveBody(values, savedRef.current, revision);
      return loadedFrom(await apiData(postApiV1AdminSettingsTracking({ body: { consent: body.consent } })));
    },
    resolveSavedValues: (result) => result,
    defaultValues: PRIVACY_DEFAULTS,
    errorMessage: common("saveFailed"),
    canEdit,
  });
  savedRef.current = form.savedValues;
  if (form.isLoadError) return <SettingsLoadFailure title={t("loadSettings")} error={form.loadError} onRetry={form.refetch} />;
  if (!form.isLoaded) return <SettingsCardLoading />;
  const value = form.values.otherRegions;
  // Europe's fixed rule matters only to a store that sells there (P11).
  const europe = (markets.data ?? []).some((market) => sellsWhereLawAsks(market.countries));
  // Recommended first, then the stricter and the lighter choice.
  const order: ConsentRegime[] = ["notice", ...CONSENT_REGIMES.filter((regime) => regime !== "notice")];
  const legend = t(europe ? "otherRegionsOutsideEurope" : "otherRegions");
  return (
    <SettingsCard id="cookieBanner" title={t("bannerTitle")} description={t("bannerDescription")}>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-body font-medium">{legend}</legend>
        <RadioGroup aria-label={legend} value={value} disabled={!canEdit} onValueChange={(next) => form.setValue("otherRegions", next as ConsentRegime)}>
          {order.map((regime) => (
            <label key={regime} className="flex min-h-11 items-start gap-2 py-2 text-body">
              <span className="flex h-lh items-center"><RadioGroupItem value={regime} /></span>
              <span>
                <span className="block font-medium">{t(`regime.${regime}`)}</span>
                <span className="block text-muted-foreground">{t(`regime.${regime}Help`)}</span>
              </span>
            </label>
          ))}
        </RadioGroup>
      </fieldset>
      <div className="flex flex-col gap-1 border-t border-border pt-4">
        {europe ? (
          <>
            <p className="text-body font-medium">{t("europeTitle")}</p>
            <p className="text-body text-muted-foreground">{t("europeText")}</p>
          </>
        ) : null}
        <p className="text-body text-muted-foreground">{t("gpcNote")}</p>
      </div>
      {markets.data && markets.data.length > 1 ? (
        <div className="flex flex-col gap-1 border-t border-border pt-4">
          <p className="text-body font-medium">{t("marketsTitle")}</p>
          <ul className="flex flex-col gap-1">
            {markets.data.map((market) => {
              const regime = consentRegimeFor(market.countries, { otherRegions: value });
              const byLaw = regime === "opt_in" && consentRegimeFor(market.countries, { otherRegions: "notice" }) === "opt_in";
              return (
                <li key={market.id} className="flex items-center justify-between gap-3 text-body">
                  <span className="min-w-0 truncate" title={market.name}>{market.name}</span>
                  <span className="text-muted-foreground">{t(REGIME_LABEL[regime])}{byLaw ? ` · ${t("marketByLaw")}` : ""}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </SettingsCard>
  );
}

const SIGNALS = ["em", "ph", "fbp", "fbc", "ip", "ua", "ttp", "ttclid", "gaClientId", "gaSessionId", "gclid"] as const;

/** What customers allowed on the last day's orders; the match details sit behind "Details". */
export function CustomerDataCard() {
  const t = useMessages(settingsPrivacyMessages);
  const health = useQuery(trackingHealthQuery);
  if (health.isError) return <SettingsLoadFailure title={t("loadHealth")} error={health.error} onRetry={health.refetch} />;
  if (!health.data) return <SettingsCardLoading />;
  const data = health.data;
  const coverage = data.matchSignalCoverage;
  const percent = (value: number) => formatNumber(value / 100, { style: "percent", maximumFractionDigits: 1 });
  return (
    <SettingsCard id="customerData" title={t("customerDataTitle")} description={t("customerDataDescription", { hours: data.windowHours })}>
      {data.consent.orders === 0 ? (
        <p className="text-body text-muted-foreground">{t("noOrders")}</p>
      ) : (
        <>
          <p className="text-body text-muted-foreground">
            {t("consentText", {
              count: data.consent.orders,
              analytics: formatNumber(data.consent.analyticsGranted),
              marketing: formatNumber(data.consent.marketingGranted),
              sale: formatNumber(data.consent.saleOfDataGranted),
            })}
          </p>
          {coverage.orders > 0 ? (
            <Suspense fallback={null}>
              <SettingsAdvanced label={t("details")}>
                <p className="text-body text-muted-foreground">{t("signalsHelp", { count: coverage.orders })}</p>
                <dl className="grid gap-2 sm:grid-cols-2">
                  {SIGNALS.map((signal) => (
                    <div key={signal} className="flex items-center justify-between gap-3 text-body">
                      <dt className="text-muted-foreground">{t(`signal.${signal}`)}</dt>
                      <dd className="tabular-nums">{percent(coverage.percent[signal] ?? 0)}</dd>
                    </div>
                  ))}
                </dl>
              </SettingsAdvanced>
            </Suspense>
          ) : null}
        </>
      )}
    </SettingsCard>
  );
}
