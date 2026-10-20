// Settings → Integrations: one card per tracking destination (Google
// Analytics, Facebook & Instagram, TikTok), as each Shopify channel app owns
// its pixel and its server events. A card holds the tag on the store, the
// sales the store sends itself (reusing the tag's ID, so a pixel code is typed
// once), the test mode or test code, and the last day's health with "Send
// test sale". Code-split: the Integrations page loads it after its own cards.
import { lazy, Suspense, useRef, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { postApiV1AdminAnalyticsTestEvent, postApiV1AdminSettingsTracking } from "@scalius/api-client/sdk";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { ChoiceField, ReadOnlyValue } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { usePermissions } from "~/contexts/PermissionContext";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { readAdminApiError } from "~/lib/admin-api-error";
import { apiData } from "~/lib/api";
import { trackingQuery } from "~/lib/api-query-options/settings-screens";
import { toast } from "~/lib/toast";
import { formatDateTime, useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { appsMessages } from "~/i18n/settings-apps";
import { settingsPrivacyMessages, type SettingsPrivacyMessageKey } from "~/i18n/settings-privacy";
import { DESTINATION_SCRIPT_TYPES, MetaConnectionFields, RecentEvents, ScriptList } from "./AppsSettings";
import { OfficialProviderMark, type ProviderMarkId } from "./provider-marks";
import { SettingsLoadFailure } from "./SettingsLoadFailure";
import { SettingsCard, SettingsCardLoading, SettingsField } from "./SettingsPage";
import {
  PRIVACY_DEFAULTS,
  loadedFrom,
  privacyProblems,
  tagIdsFrom,
  trackingHealthQuery,
  trackingSaveBody,
  trackingSettingsQuery,
  withTagIds,
  type Destination,
  type Loaded,
  type PrivacyValues,
  type Revisions,
  type TagIds,
  type TrackingHealth,
} from "./tracking-settings";

const SettingsAdvanced = lazy(() => import("./SettingsAdvanced").then((module) => ({ default: module.SettingsAdvanced })));

export default function TrackingDestinationCards() {
  const { hasPermission } = usePermissions();
  if (!hasPermission(ADMIN_PERMISSIONS.ANALYTICS_VIEW)) return null;
  return (
    <>
      <GoogleCard />
      <MetaCard />
      <TikTokCard />
    </>
  );
}

function useTagIds(): TagIds {
  return tagIdsFrom(useQuery(trackingQuery).data?.scripts ?? []);
}

function DestinationCard({ id, mark, title, description, tag, children }: {
  id: "google" | "facebook" | "tiktok";
  mark: ProviderMarkId;
  title: string;
  description: string;
  tag: ReactNode;
  children: ReactNode;
}) {
  const t = useMessages(settingsPrivacyMessages);
  return (
    <SettingsCard
      id={id}
      title={
        <span className="flex items-center gap-3">
          <OfficialProviderMark provider={mark} size="sm" />
          {title}
        </span>
      }
      description={description}
    >
      <section className="-mx-4 flex flex-col gap-1 border-t border-border pt-4" aria-labelledby={`${id}-tag-title`}>
        <h3 id={`${id}-tag-title`} className="px-4 text-heading-sm">{t("tagTitle")}</h3>
        {tag}
      </section>
      {children}
    </SettingsCard>
  );
}

/**
 * The Google or TikTok section of the tracking document, saved with the page
 * at its own revision; an empty ID is the tag's.
 */
function useSectionForm(section: "ga4" | "tiktok", ids: TagIds) {
  const t = useMessages(settingsPrivacyMessages);
  const common = useMessages(settingsMessages);
  const canEdit = usePermissions().hasPermission(ADMIN_PERMISSIONS.ANALYTICS_EDIT);
  const savedRef = useRef<PrivacyValues>(PRIVACY_DEFAULTS);
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const enabledField = section === "ga4" ? "ga4-enabled" : "tiktok-enabled";
  const form = useSettingsForm<PrivacyValues, Loaded, Revisions>({
    label: t(section === "ga4" ? "googleTitle" : "tiktokTitle"),
    queryKey: trackingSettingsQuery.queryKey,
    fetchFn: trackingSettingsQuery.queryFn,
    saveFn: async (values, revision) => {
      const body = trackingSaveBody(withTagIds(values, idsRef.current, section), savedRef.current, revision);
      // Only this card's section travels, whatever else the shared document's draft holds.
      return loadedFrom(await apiData(postApiV1AdminSettingsTracking({ body: section === "ga4" ? { ga4: body.ga4 } : { tiktok: body.tiktok } })));
    },
    resolveSavedValues: (result) => result,
    defaultValues: PRIVACY_DEFAULTS,
    errorMessage: common("saveFailed"),
    canEdit,
    isValid: (values) => Object.keys(privacyProblems(values, idsRef.current)).some((field) => field.startsWith(section)) === false,
    // The save bar names the reason and moves focus to the checkbox (C5, F8).
    problems: (values) => {
      const problem = privacyProblems(values, idsRef.current)[enabledField];
      return problem ? [{ message: t(problem), target: enabledField }] : [];
    },
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
  return { form, canEdit };
}

/** The checkbox that turns a destination's sales on, its reason under it while it can't be saved (C5, F8). */
function SendSalesChoice({ id, label, help, error, checked, disabled, onChange }: {
  id: string;
  label: string;
  help: string;
  error: string | undefined;
  checked: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <ChoiceField
      id={id}
      label={label}
      help={help}
      error={error}
      control={
        <Checkbox
          id={id}
          checked={checked}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : `${id}-help`}
          onCheckedChange={(value) => onChange(value === true)}
        />
      }
    />
  );
}

function SalesSection({ children }: { children: ReactNode }) {
  const t = useMessages(settingsPrivacyMessages);
  return (
    <section className="flex flex-col gap-4 border-t border-border pt-4" aria-label={t("salesTitle")}>
      <div className="flex flex-col gap-1">
        <h3 className="text-heading-sm">{t("salesTitle")}</h3>
        <p className="text-body text-muted-foreground">{t("salesHelp")}</p>
      </div>
      {children}
    </section>
  );
}

function GoogleCard() {
  const t = useMessages(settingsPrivacyMessages);
  const ids = useTagIds();
  const { form, canEdit } = useSectionForm("ga4", ids);
  const tag = <ScriptList types={DESTINATION_SCRIPT_TYPES.ga4} emptyLabel={t("noGoogleTag")} addLabel={t("addGoogleTag")} />;
  const body = () => {
    if (form.isLoadError) return <SettingsLoadFailure title={t("loadSettings")} error={form.loadError} onRetry={form.refetch} />;
    if (!form.isLoaded) return <SettingsCardLoading />;
    const { values, setValue } = form;
    const problems = privacyProblems(values, ids);
    const ga4 = values.ga4;
    const reusesTag = Boolean(ids.ga4) && (!ga4.measurementId.trim() || ga4.measurementId.trim() === ids.ga4);
    return (
      <SalesSection>
        <SendSalesChoice
          id="ga4-enabled"
          label={t("ga4Enabled")}
          help={t("ga4EnabledHelp")}
          error={problems["ga4-enabled"] ? t(problems["ga4-enabled"]) : undefined}
          checked={ga4.isEnabled}
          disabled={!canEdit}
          onChange={(on) => setValue("ga4", { ...ga4, isEnabled: on })}
        />
        {reusesTag ? (
          <ReadOnlyValue label={t("measurementId")} value={ids.ga4} help={t("measurementIdFromTag")} mono />
        ) : (
          <SettingsField id="ga4-measurement-id" label={t("measurementId")} help={t("measurementIdHelp")} error={problems["ga4-measurement-id"] ? t(problems["ga4-measurement-id"]) : undefined}>
            <Input id="ga4-measurement-id" value={ga4.measurementId} placeholder="G-1A2B3C4D5E" autoComplete="off" spellCheck={false} maxLength={32} disabled={!canEdit} onChange={(event) => setValue("ga4", { ...ga4, measurementId: event.target.value })} />
          </SettingsField>
        )}
        <SettingsField id="ga4-api-secret" label={t("apiSecret")} help={ga4.apiSecret && ga4.apiSecret === form.savedValues.ga4.apiSecret ? t("secretSaved") : t("apiSecretHelp")}>
          <Input id="ga4-api-secret" type="password" value={ga4.apiSecret} autoComplete="off" spellCheck={false} maxLength={4096} disabled={!canEdit} onChange={(event) => setValue("ga4", { ...ga4, apiSecret: event.target.value })} />
        </SettingsField>
        <ChoiceField
          id="ga4-debug"
          label={t("ga4Debug")}
          help={t("ga4DebugHelp")}
          control={<Checkbox id="ga4-debug" checked={ga4.debugMode} disabled={!canEdit} aria-describedby="ga4-debug-help" onCheckedChange={(checked) => setValue("ga4", { ...ga4, debugMode: checked === true })} />}
        />
      </SalesSection>
    );
  };
  return (
    <DestinationCard id="google" mark="google-analytics" title={t("googleTitle")} description={t("googleDescription")} tag={tag}>
      {body()}
      <DestinationHealth name="ga4" />
    </DestinationCard>
  );
}

function TikTokCard() {
  const t = useMessages(settingsPrivacyMessages);
  const ids = useTagIds();
  const { form, canEdit } = useSectionForm("tiktok", ids);
  const tag = <ScriptList types={DESTINATION_SCRIPT_TYPES.tiktok} emptyLabel={t("noTiktokTag")} addLabel={t("addTiktokTag")} />;
  const body = () => {
    if (form.isLoadError) return <SettingsLoadFailure title={t("loadSettings")} error={form.loadError} onRetry={form.refetch} />;
    if (!form.isLoaded) return <SettingsCardLoading />;
    const { values, setValue } = form;
    const problems = privacyProblems(values, ids);
    const tiktok = values.tiktok;
    const reusesTag = Boolean(ids.tiktok) && (!tiktok.pixelCode.trim() || tiktok.pixelCode.trim() === ids.tiktok);
    return (
      <SalesSection>
        <SendSalesChoice
          id="tiktok-enabled"
          label={t("tiktokEnabled")}
          help={t("tiktokEnabledHelp")}
          error={problems["tiktok-enabled"] ? t(problems["tiktok-enabled"]) : undefined}
          checked={tiktok.isEnabled}
          disabled={!canEdit}
          onChange={(on) => setValue("tiktok", { ...tiktok, isEnabled: on })}
        />
        {reusesTag ? (
          <ReadOnlyValue label={t("pixelCode")} value={ids.tiktok} help={t("pixelCodeFromTag")} mono />
        ) : (
          <SettingsField id="tiktok-pixel-code" label={t("pixelCode")} help={t("pixelCodeHelp")} error={problems["tiktok-pixel-code"] ? t(problems["tiktok-pixel-code"]) : undefined}>
            <Input id="tiktok-pixel-code" value={tiktok.pixelCode} autoComplete="off" spellCheck={false} maxLength={64} disabled={!canEdit} onChange={(event) => setValue("tiktok", { ...tiktok, pixelCode: event.target.value })} />
          </SettingsField>
        )}
        <SettingsField id="tiktok-access-token" label={t("accessToken")} help={tiktok.accessToken && tiktok.accessToken === form.savedValues.tiktok.accessToken ? t("secretSaved") : t("accessTokenHelp")}>
          <Input id="tiktok-access-token" type="password" value={tiktok.accessToken} autoComplete="off" spellCheck={false} maxLength={4096} disabled={!canEdit} onChange={(event) => setValue("tiktok", { ...tiktok, accessToken: event.target.value })} />
        </SettingsField>
        <SettingsField id="tiktok-test-event-code" label={t("testEventCode")} optional help={t("testEventCodeHelp")}>
          <Input id="tiktok-test-event-code" value={tiktok.testEventCode} autoComplete="off" spellCheck={false} maxLength={64} disabled={!canEdit} onChange={(event) => setValue("tiktok", { ...tiktok, testEventCode: event.target.value })} />
        </SettingsField>
      </SalesSection>
    );
  };
  return (
    <DestinationCard id="tiktok" mark="tiktok" title={t("tiktokTitle")} description={t("tiktokDescription")} tag={tag}>
      {body()}
      <DestinationHealth name="tiktok" />
    </DestinationCard>
  );
}

function MetaCard() {
  const t = useMessages(settingsPrivacyMessages);
  const apps = useMessages(appsMessages);
  const ids = useTagIds();
  const canEdit = usePermissions().hasPermission(ADMIN_PERMISSIONS.ANALYTICS_EDIT);
  const tag = <ScriptList types={DESTINATION_SCRIPT_TYPES.meta} emptyLabel={apps("noMetaTag")} addLabel={apps("addMetaTag")} />;
  return (
    <DestinationCard id="facebook" mark="meta" title={apps("facebookTitle")} description={apps("facebookDescription")} tag={tag}>
      <SalesSection>
        <MetaConnectionFields canEdit={canEdit} tagPixelId={ids.meta} />
        <p className="text-body text-muted-foreground">{t("limitedDataUse")}</p>
      </SalesSection>
      <DestinationHealth name="meta">
        <Suspense fallback={null}>
          <SettingsAdvanced label={apps("recentEvents")}>
            <RecentEvents />
          </SettingsAdvanced>
        </Suspense>
      </DestinationHealth>
    </DestinationCard>
  );
}

/** Tracking health names events as the platforms do; the merchant reads them in plain words. */
const EVENT_WORDS: Record<string, SettingsPrivacyMessageKey> = {
  purchase: "event.purchase",
  completepayment: "event.purchase",
  placeanorder: "event.purchase",
  refund: "event.refund",
  addtocart: "event.add_to_cart",
  add_to_cart: "event.add_to_cart",
  initiatecheckout: "event.checkout",
  begin_checkout: "event.checkout",
  addpaymentinfo: "event.payment_info",
  add_payment_info: "event.payment_info",
  viewcontent: "event.view",
  view_item: "event.view",
};

type Counts = Pick<TrackingHealth["destinations"][number]["events"][number], "sent" | "failed" | "skipped" | "pending">;

/** "9 sent · 1 failed": counts that are zero are left out (P11). */
export function countsLine(counts: Counts, t: (key: SettingsPrivacyMessageKey, vars: Record<string, number>) => string): string {
  return ([["sent", "countSent"], ["failed", "countFailed"], ["skipped", "countSkipped"], ["pending", "countPending"]] as const)
    .filter(([field]) => counts[field] > 0)
    .map(([field, key]) => t(key, { count: counts[field] }))
    .join(" · ");
}

function DestinationHealth({ name, children }: { name: Destination; children?: ReactNode }) {
  const t = useMessages(settingsPrivacyMessages);
  const canSend = usePermissions().hasPermission(ADMIN_PERMISSIONS.ANALYTICS_EDIT);
  const health = useQuery(trackingHealthQuery);
  const test = useMutation({
    mutationFn: () => apiData(postApiV1AdminAnalyticsTestEvent({ body: { destination: name } })),
    onSuccess: (result) => {
      if (result.accepted) toast.success(t("testSent"));
      void health.refetch();
    },
  });
  if (health.isError) return <SettingsLoadFailure title={t("loadHealth")} error={health.error} onRetry={health.refetch} />;
  if (!health.data) return null;
  const destination = health.data.destinations.find((entry) => entry.destination === name) ?? null;
  const configured = destination?.configured === true;
  const status = !configured ? "statusOff" : destination?.testMode ? "statusTest" : "statusOn";
  const variant = !configured ? "secondary" : destination?.testMode ? "warning" : "success";
  const events = (destination?.events ?? []).filter((event) => event.sent + event.failed + event.skipped + event.pending > 0);
  const testResult = test.data
    ? test.data.accepted
      ? t("testAccepted", { place: t(`place.${name}`) })
      : t("testRejected", { message: rejection(test.data.details) })
    : test.error
      ? readAdminApiError(test.error)?.status === 409 ? t("testNeedsCode") : t("testFailed")
      : null;
  const headingId = `health-${name}`;
  return (
    <section className="flex flex-col gap-1 border-t border-border pt-4" aria-labelledby={headingId}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={headingId} className="text-heading-sm">{t("healthTitle", { hours: health.data.windowHours })}</h3>
        <Badge variant={variant}>{t(status)}</Badge>
      </div>
      {configured ? (
        <>
          {events.length === 0 ? (
            <p className="text-body text-muted-foreground">{t("noEvents")}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {events.map((event) => {
                const key = EVENT_WORDS[event.event.toLowerCase()];
                return (
                  <li key={event.event} className="text-body text-muted-foreground">
                    {t("eventLine", { event: key ? t(key) : event.event, counts: countsLine(event, t) })}
                  </li>
                );
              })}
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
            <div className="flex flex-col items-start gap-1 pt-2">
              <Button type="button" variant="outline" size="sm" loading={test.isPending} onClick={() => test.mutate()}>{t("sendTest")}</Button>
              {testResult ? (
                <p role="status" className={test.data?.accepted ? "text-body text-muted-foreground" : "text-body text-destructive"}>{testResult}</p>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
      {children}
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
