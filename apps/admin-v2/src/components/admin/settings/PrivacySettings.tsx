// Settings → Customer privacy: the cookie banner (one choice for markets
// outside Europe, the UK and Switzerland, which always ask first), server
// events to Google Analytics 4 and TikTok with their test modes, and the
// last day's tracking health with "Send test event". One save bar: each
// changed section saves at the revision it was loaded at
// (`POST /admin/settings/tracking`). Secrets come back masked and stay as
// they are unless the merchant pastes a new one.
import { useRef } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  getApiV1AdminAnalyticsTrackingHealth,
  getApiV1AdminSettingsTracking,
  postApiV1AdminAnalyticsTestEvent,
  postApiV1AdminSettingsTracking,
} from "@scalius/api-client/sdk";
import { CONSENT_REGIMES, consentRegimeFor, type ConsentRegime } from "@scalius/shared/tracking-consent";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { ChoiceField } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { readAdminApiError } from "~/lib/admin-api-error";
import { apiData, type ApiBody, type ApiResult } from "~/lib/api";
import { marketsQueryOptions } from "~/lib/api-query-options/markets";
import { toast } from "~/lib/toast";
import { formatDateTime, formatNumber, useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { settingsPrivacyMessages, type SettingsPrivacyMessageKey } from "~/i18n/settings-privacy";
import { SettingsLoadFailure } from "./SettingsLoadFailure";
import { SettingsCard, SettingsCardLoading, SettingsField } from "./SettingsPage";

type TrackingSettings = ApiResult<typeof getApiV1AdminSettingsTracking>;
type TrackingHealth = ApiResult<typeof getApiV1AdminAnalyticsTrackingHealth>;
type Destination = TrackingHealth["destinations"][number]["destination"];
type SaveBody = ApiBody<typeof postApiV1AdminSettingsTracking>;

export interface PrivacyValues {
  otherRegions: ConsentRegime;
  ga4: { isEnabled: boolean; measurementId: string; apiSecret: string; debugMode: boolean };
  tiktok: { isEnabled: boolean; pixelCode: string; accessToken: string; testEventCode: string };
}
type Revisions = { consent: number; ga4: number; tiktok: number };
type Loaded = PrivacyValues & { revision: Revisions };

export const trackingSettingsQuery = {
  queryKey: ["settings", "tracking"] as const,
  queryFn: async (): Promise<Loaded> => loadedFrom(await apiData(getApiV1AdminSettingsTracking())),
};

export const trackingHealthQuery = {
  queryKey: ["settings", "tracking", "health"] as const,
  queryFn: () => apiData(getApiV1AdminAnalyticsTrackingHealth()),
};

/** The API's document as the form's values, with each section's revision beside them. */
export function loadedFrom(settings: TrackingSettings): Loaded {
  return {
    otherRegions: settings.consent.otherRegions,
    ga4: {
      isEnabled: settings.ga4.isEnabled,
      measurementId: settings.ga4.measurementId ?? "",
      apiSecret: settings.ga4.apiSecret ?? "",
      debugMode: settings.ga4.debugMode,
    },
    tiktok: {
      isEnabled: settings.tiktok.isEnabled,
      pixelCode: settings.tiktok.pixelCode ?? "",
      accessToken: settings.tiktok.accessToken ?? "",
      testEventCode: settings.tiktok.testEventCode ?? "",
    },
    revision: { consent: settings.consent.revision, ga4: settings.ga4.revision, tiktok: settings.tiktok.revision },
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Only the sections that changed, each at its own revision; a secret goes
 * only when the merchant typed a new one (the masked value keeps it).
 */
export function trackingSaveBody(values: PrivacyValues, saved: PrivacyValues, revision: Revisions): SaveBody {
  const body: SaveBody = {};
  if (values.otherRegions !== saved.otherRegions) {
    body.consent = { otherRegions: values.otherRegions, expectedRevision: revision.consent };
  }
  if (!same(values.ga4, saved.ga4)) {
    const { apiSecret, ...rest } = values.ga4;
    body.ga4 = { ...rest, measurementId: rest.measurementId.trim(), ...(apiSecret !== saved.ga4.apiSecret ? { apiSecret } : {}), expectedRevision: revision.ga4 };
  }
  if (!same(values.tiktok, saved.tiktok)) {
    const { accessToken, ...rest } = values.tiktok;
    body.tiktok = {
      ...rest,
      pixelCode: rest.pixelCode.trim(),
      testEventCode: rest.testEventCode.trim(),
      ...(accessToken !== saved.tiktok.accessToken ? { accessToken } : {}),
      expectedRevision: revision.tiktok,
    };
  }
  return body;
}

const GA4_ID = /^G-[A-Z0-9]{4,}$/i;
const PIXEL_CODE = /^[A-Z0-9]+$/i;

/** What blocks saving, by field id (the API refuses the same). */
export function privacyProblems(values: PrivacyValues): Partial<Record<"ga4-measurement-id" | "ga4-enabled" | "tiktok-pixel-code" | "tiktok-enabled", SettingsPrivacyMessageKey>> {
  const problems: ReturnType<typeof privacyProblems> = {};
  const measurementId = values.ga4.measurementId.trim();
  if (measurementId && !GA4_ID.test(measurementId)) problems["ga4-measurement-id"] = "measurementIdInvalid";
  if (values.ga4.isEnabled && (!measurementId || !values.ga4.apiSecret.trim())) problems["ga4-enabled"] = "ga4Needs";
  const pixelCode = values.tiktok.pixelCode.trim();
  if (pixelCode && !PIXEL_CODE.test(pixelCode)) problems["tiktok-pixel-code"] = "pixelCodeInvalid";
  if (values.tiktok.isEnabled && (!pixelCode || !values.tiktok.accessToken.trim())) problems["tiktok-enabled"] = "tiktokNeeds";
  return problems;
}

const DEFAULTS: PrivacyValues = {
  otherRegions: "notice",
  ga4: { isEnabled: false, measurementId: "", apiSecret: "", debugMode: false },
  tiktok: { isEnabled: false, pixelCode: "", accessToken: "", testEventCode: "" },
};

/** The banner and server events: one document set, one save bar. */
export function PrivacySettingsCards() {
  const t = useMessages(settingsPrivacyMessages);
  const common = useMessages(settingsMessages);
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.ANALYTICS_EDIT);
  const savedRef = useRef<PrivacyValues>(DEFAULTS);
  const form = useSettingsForm<PrivacyValues, Loaded, Revisions>({
    label: t("serverTitle"),
    queryKey: trackingSettingsQuery.queryKey,
    fetchFn: trackingSettingsQuery.queryFn,
    saveFn: async (values, revision) =>
      loadedFrom(await apiData(postApiV1AdminSettingsTracking({ body: trackingSaveBody(values, savedRef.current, revision) }))),
    resolveSavedValues: (result) => result,
    defaultValues: DEFAULTS,
    errorMessage: common("saveFailed"),
    canEdit,
    isValid: (values) => Object.keys(privacyProblems(values)).length === 0,
    fields: (path) => {
      if (path.startsWith("ga4.measurementId")) return "ga4-measurement-id";
      if (path.startsWith("ga4.apiSecret")) return "ga4-api-secret";
      if (path.startsWith("tiktok.pixelCode")) return "tiktok-pixel-code";
      if (path.startsWith("tiktok.accessToken")) return "tiktok-access-token";
      if (path.startsWith("tiktok.testEventCode")) return "tiktok-test-event-code";
      return undefined;
    },
  });
  savedRef.current = form.savedValues;
  if (form.isLoadError) return <SettingsLoadFailure title={t("loadSettings")} error={form.loadError} onRetry={form.refetch} />;
  if (!form.isLoaded) return <SettingsCardLoading />;
  const { values, setValue } = form;
  const problems = privacyProblems(values);
  const problem = (id: keyof typeof problems) => (problems[id] ? t(problems[id]!) : undefined);

  return (
    <>
      <CookieBannerCard value={values.otherRegions} canEdit={canEdit} onChange={(otherRegions) => setValue("otherRegions", otherRegions)} />

      <SettingsCard id="serverEvents" title={t("serverTitle")} description={t("serverDescription")}>
        <section className="space-y-4" aria-labelledby="ga4-title">
          <h3 id="ga4-title" className="text-heading-sm">{t("ga4Title")}</h3>
          <ChoiceField
            id="ga4-enabled"
            label={t("ga4Enabled")}
            help={problem("ga4-enabled") ?? t("ga4EnabledHelp")}
            control={<Checkbox id="ga4-enabled" checked={values.ga4.isEnabled} disabled={!canEdit} aria-describedby="ga4-enabled-help" onCheckedChange={(checked) => setValue("ga4", { ...values.ga4, isEnabled: checked === true })} />}
          />
          <SettingsField id="ga4-measurement-id" label={t("measurementId")} help={t("measurementIdHelp")} error={problem("ga4-measurement-id")}>
            <Input id="ga4-measurement-id" value={values.ga4.measurementId} placeholder="G-1A2B3C4D5E" autoComplete="off" spellCheck={false} maxLength={32} disabled={!canEdit} onChange={(event) => setValue("ga4", { ...values.ga4, measurementId: event.target.value })} />
          </SettingsField>
          <SettingsField id="ga4-api-secret" label={t("apiSecret")} help={values.ga4.apiSecret && values.ga4.apiSecret === form.savedValues.ga4.apiSecret ? t("secretSaved") : t("apiSecretHelp")}>
            <Input id="ga4-api-secret" type="password" value={values.ga4.apiSecret} autoComplete="off" spellCheck={false} maxLength={4096} disabled={!canEdit} onChange={(event) => setValue("ga4", { ...values.ga4, apiSecret: event.target.value })} />
          </SettingsField>
          <ChoiceField
            id="ga4-debug"
            label={t("ga4Debug")}
            help={t("ga4DebugHelp")}
            control={<Checkbox id="ga4-debug" checked={values.ga4.debugMode} disabled={!canEdit} aria-describedby="ga4-debug-help" onCheckedChange={(checked) => setValue("ga4", { ...values.ga4, debugMode: checked === true })} />}
          />
        </section>

        <section className="space-y-4 border-t border-border pt-4" aria-labelledby="tiktok-title">
          <h3 id="tiktok-title" className="text-heading-sm">{t("tiktokTitle")}</h3>
          <ChoiceField
            id="tiktok-enabled"
            label={t("tiktokEnabled")}
            help={problem("tiktok-enabled") ?? t("tiktokEnabledHelp")}
            control={<Checkbox id="tiktok-enabled" checked={values.tiktok.isEnabled} disabled={!canEdit} aria-describedby="tiktok-enabled-help" onCheckedChange={(checked) => setValue("tiktok", { ...values.tiktok, isEnabled: checked === true })} />}
          />
          <SettingsField id="tiktok-pixel-code" label={t("pixelCode")} help={t("pixelCodeHelp")} error={problem("tiktok-pixel-code")}>
            <Input id="tiktok-pixel-code" value={values.tiktok.pixelCode} autoComplete="off" spellCheck={false} maxLength={64} disabled={!canEdit} onChange={(event) => setValue("tiktok", { ...values.tiktok, pixelCode: event.target.value })} />
          </SettingsField>
          <SettingsField id="tiktok-access-token" label={t("accessToken")} help={values.tiktok.accessToken && values.tiktok.accessToken === form.savedValues.tiktok.accessToken ? t("secretSaved") : t("accessTokenHelp")}>
            <Input id="tiktok-access-token" type="password" value={values.tiktok.accessToken} autoComplete="off" spellCheck={false} maxLength={4096} disabled={!canEdit} onChange={(event) => setValue("tiktok", { ...values.tiktok, accessToken: event.target.value })} />
          </SettingsField>
          <SettingsField id="tiktok-test-event-code" label={t("testEventCode")} optional help={t("testEventCodeHelp")}>
            <Input id="tiktok-test-event-code" value={values.tiktok.testEventCode} autoComplete="off" spellCheck={false} maxLength={64} disabled={!canEdit} onChange={(event) => setValue("tiktok", { ...values.tiktok, testEventCode: event.target.value })} />
          </SettingsField>
        </section>

        <section className="space-y-1 border-t border-border pt-4" aria-labelledby="meta-title">
          <h3 id="meta-title" className="text-heading-sm">{t("metaTitle")}</h3>
          <p className="text-body text-muted-foreground">
            {t("metaText")}{" "}
            <Link to="/admin/settings/integrations" hash="facebook" className="text-link hover:underline">{t("openFacebook")}</Link>
          </p>
          <p className="text-body text-muted-foreground"><span className="font-medium text-foreground">{t("limitedDataUse")}:</span> {t("limitedDataUseText")}</p>
        </section>
      </SettingsCard>
    </>
  );
}

const REGIME_LABEL: Record<ConsentRegime, SettingsPrivacyMessageKey> = {
  notice: "marketTells",
  opt_in: "marketAsks",
  link_only: "marketLinkOnly",
};

/** The choice for markets outside Europe, the fixed rule for Europe, and what each market gets. */
function CookieBannerCard({ value, canEdit, onChange }: { value: ConsentRegime; canEdit: boolean; onChange: (value: ConsentRegime) => void }) {
  const t = useMessages(settingsPrivacyMessages);
  const markets = useQuery(marketsQueryOptions());
  // Recommended first, then the stricter and the lighter choice.
  const order: ConsentRegime[] = ["notice", ...CONSENT_REGIMES.filter((regime) => regime !== "notice")];
  return (
    <SettingsCard id="cookieBanner" title={t("bannerTitle")} description={t("bannerDescription")}>
      <fieldset className="space-y-1">
        <legend className="text-body font-medium">{t("otherRegions")}</legend>
        <RadioGroup aria-label={t("otherRegions")} value={value} disabled={!canEdit} onValueChange={(next) => onChange(next as ConsentRegime)}>
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
      <div className="space-y-1 border-t border-border pt-4">
        <p className="text-body font-medium">{t("europeTitle")}</p>
        <p className="text-body text-muted-foreground">{t("europeText")}</p>
        <p className="text-body text-muted-foreground">{t("gpcNote")}</p>
      </div>
      {markets.data && markets.data.length > 0 ? (
        <div className="space-y-1 border-t border-border pt-4">
          <p className="text-body font-medium">{t("marketsTitle")}</p>
          <ul className="space-y-1">
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

const DESTINATIONS: readonly Destination[] = ["meta", "ga4", "tiktok"];
const SIGNALS = ["em", "ph", "fbp", "fbc", "ip", "ua", "ttp", "ttclid", "gaClientId", "gaSessionId", "gclid"] as const;

/** The last day's server events per destination, match-signal coverage and customers' choices. */
export function TrackingHealthCard() {
  const t = useMessages(settingsPrivacyMessages);
  const health = useQuery(trackingHealthQuery);
  if (health.isError) return <SettingsLoadFailure title={t("loadHealth")} error={health.error} onRetry={health.refetch} />;
  if (!health.data) return <SettingsCardLoading />;
  const data = health.data;
  const coverage = data.matchSignalCoverage;
  const percent = (value: number) => formatNumber(value / 100, { style: "percent", maximumFractionDigits: 1 });
  return (
    <SettingsCard id="trackingHealth" title={t("healthTitle")} description={t("healthDescription", { hours: data.windowHours })}>
      {DESTINATIONS.map((name, index) => {
        const destination = data.destinations.find((entry) => entry.destination === name);
        return (
          <DestinationHealth
            key={name}
            name={name}
            destination={destination ?? null}
            first={index === 0}
            onSent={() => void health.refetch()}
          />
        );
      })}
      <section className="space-y-1 border-t border-border pt-4" aria-labelledby="signals-title">
        <h3 id="signals-title" className="text-heading-sm">{t("signalsTitle")}</h3>
        {coverage.orders === 0 ? (
          <p className="text-body text-muted-foreground">{t("noOrders")}</p>
        ) : (
          <>
            <p className="text-body text-muted-foreground">{t("signalsHelp", { count: coverage.orders })}</p>
            <dl className="grid gap-2 sm:grid-cols-2">
              {SIGNALS.map((signal) => (
                <div key={signal} className="flex items-center justify-between gap-3 text-body">
                  <dt className="text-muted-foreground">{t(`signal.${signal}`)}</dt>
                  <dd className="tabular-nums">{percent(coverage.percent[signal] ?? 0)}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </section>
      {data.consent.orders > 0 ? (
        <section className="space-y-1 border-t border-border pt-4" aria-labelledby="consent-title">
          <h3 id="consent-title" className="text-heading-sm">{t("consentTitle")}</h3>
          <p className="text-body text-muted-foreground">
            {t("consentText", {
              count: data.consent.orders,
              analytics: formatNumber(data.consent.analyticsGranted),
              marketing: formatNumber(data.consent.marketingGranted),
              sale: formatNumber(data.consent.saleOfDataGranted),
            })}
          </p>
        </section>
      ) : null}
    </SettingsCard>
  );
}

function DestinationHealth({ name, destination, first, onSent }: {
  name: Destination;
  destination: TrackingHealth["destinations"][number] | null;
  first: boolean;
  onSent: () => void;
}) {
  const t = useMessages(settingsPrivacyMessages);
  const canSend = useHasPermission(ADMIN_PERMISSIONS.ANALYTICS_EDIT);
  const test = useMutation({
    mutationFn: () => apiData(postApiV1AdminAnalyticsTestEvent({ body: { destination: name } })),
    onSuccess: (result) => {
      if (result.accepted) toast.success(t("testSent"));
      onSent();
    },
  });
  const configured = destination?.configured === true;
  const status = !configured ? "statusOff" : destination?.testMode ? "statusTest" : "statusOn";
  const variant = !configured ? "secondary" : destination?.testMode ? "warning" : "success";
  const testResult = test.data
    ? test.data.accepted
      ? t("testAccepted", { place: t(`place.${name}`) })
      : t("testRejected", { message: rejection(test.data.details) })
    : test.error
      ? readAdminApiError(test.error)?.status === 409 ? t("testNeedsCode") : t("testFailed")
      : null;
  const headingId = `health-${name}`;
  return (
    <section className={first ? "space-y-1" : "space-y-1 border-t border-border pt-4"} aria-labelledby={headingId}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={headingId} className="text-heading-sm">{t(`destination.${name}`)}</h3>
        <Badge variant={variant}>{t(status)}</Badge>
      </div>
      {configured ? (
        <>
          {destination!.events.length === 0 ? (
            <p className="text-body text-muted-foreground">{t("noEvents")}</p>
          ) : (
            <ul className="space-y-1">
              {destination!.events.map((event) => (
                <li key={event.event} className="text-body text-muted-foreground">
                  <code>{event.event}</code>{" "}
                  {t("eventCounts", {
                    sent: formatNumber(event.sent),
                    failed: formatNumber(event.failed),
                    skipped: formatNumber(event.skipped),
                    pending: formatNumber(event.pending),
                  })}
                </li>
              ))}
            </ul>
          )}
          {destination!.skippedByConsent > 0 ? (
            <p className="text-body text-muted-foreground">{t("skippedByConsent", { count: destination!.skippedByConsent })}</p>
          ) : null}
          {destination!.lastError ? (
            <p className="text-body text-destructive">
              {t("lastError", {
                time: formatDateTime(new Date(destination!.lastError.at), { dateStyle: "medium", timeStyle: "short" }),
                message: destination!.lastError.message,
              })}
            </p>
          ) : null}
          {canSend ? (
            <div className="space-y-1 pt-2">
              <Button type="button" variant="outline" size="sm" loading={test.isPending} onClick={() => test.mutate()}>{t("sendTest")}</Button>
              {testResult ? (
                <p role="status" className={test.data?.accepted ? "text-body text-muted-foreground" : "text-body text-destructive"}>{testResult}</p>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/** The provider's reason for refusing a test (GA4 validation messages), in one line. */
function rejection(details: Record<string, unknown>): string {
  const messages = (details.validationMessages as Array<{ description?: unknown }> | undefined) ?? [];
  const text = messages.map((message) => (typeof message.description === "string" ? message.description : "")).filter(Boolean).join(" ");
  if (text) return text;
  return typeof details.error === "string" ? details.error : typeof details.message === "string" ? details.message : "—";
}
