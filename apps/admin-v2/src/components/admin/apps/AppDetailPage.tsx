// One installed app (Shopify's app details), on one page. The header names
// it with its status and the one thing to do next (activate, or approve an
// update). The main column holds what the merchant works with: its services
// as cards by kind (each feature with its switch, consent, settings and
// health), the app's own settings, where else it appears, its checkout
// functions and jobs, its activity when there is any, and a last card to
// turn it off or uninstall it. The side column says what it is and what it
// can reach. Everything is drawn from the API's description of the app; no
// app code runs in the dashboard. A Super Admin activates (or approves an
// update) and turns features on; managers change settings, turn features
// off, deactivate and uninstall.
import { lazy, Suspense, useState } from "react";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { Page } from "~/components/admin/resource/Page";
import { ReadOnlyNotice } from "~/components/admin/states/ReadOnlyNotice";
import { SaveBarProvider, SaveErrorBanner } from "~/components/admin/shared/SaveBar";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { usePermissions } from "~/contexts/PermissionContext";
import { useLocale, useMessages } from "~/i18n";
import { providerLabel } from "~/i18n/provider-copy";
import { installedAppsMessages } from "~/i18n/apps";
import { localizedAppDetail } from "./app-detail-text";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import type { AppDetail, AppFunction } from "~/lib/api-query-options/apps";
import { formatDuration, formatWhen } from "../settings/webhooks/webhook-format";
import { AppAccess } from "./AppAccess";
import { AppFeatures } from "./AppFeatures";
import { checkoutFunctions, isKnownFunctionPoint } from "./app-functions";
import { AppActivity } from "./AppActivity";
import { AppIcon } from "./AppIcon";
import { AppListingFacts, AppScreenshots, Fact } from "./AppListingParts";
import { ActivateAppDialog, DeactivateAppDialog, UninstallAppDialog } from "./AppDialogs";
import { AppProviderSheetHost } from "./AppProviderSheetHost";
import { useAppSettingsDraft } from "./AppSettingsForm";
import { AppSettingsSections } from "./AppSettingsSections";
import { AppWhereItAppears } from "./AppWhereItAppears";
import { AppStatusBadge } from "./app-status";
import { appJobScheduleText } from "./app-job-schedule";

// The lifecycle additions (Stop now, why an app is stopped, a registry update, who signed it)
// load after the page: none of them is needed to read it.
const AppStopAction = lazy(() => import("./AppLifecycleParts").then((module) => ({ default: module.AppStopAction })));
const AppLifecycleNotices = lazy(() => import("./AppLifecycleParts").then((module) => ({ default: module.AppLifecycleNotices })));
const AppRunFacts = lazy(() => import("./AppLifecycleParts").then((module) => ({ default: module.AppRunFacts })));

type DialogName = "activate" | "deactivate" | "uninstall" | null;

const JOB_VARIANT = { running: "info", succeeded: "success", failed: "destructive" } as const;

/** The side column's first card: what the app is, who made it and how it runs here. */
function About({ app }: { app: AppDetail }) {
  const t = useMessages(installedAppsMessages);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("aboutTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {app.tagline || app.description ? (
          <div className="flex flex-col gap-1">
            {app.tagline ? <p className="text-body font-medium">{app.tagline}</p> : null}
            {app.description ? <p className="whitespace-pre-wrap break-words text-body text-muted-foreground">{app.description}</p> : null}
          </div>
        ) : null}
        <AppListingFacts app={app} columns={1}>
          <Fact label={t("runsIn")}>{t(app.runtime === "bundled" ? "runtime_bundled" : "runtime_sandbox")}</Fact>
          <Fact label={t("approvedBy")}>{app.activatedBy?.name ?? t("notApproved")}</Fact>
          {app.activatedAt ? <Fact label={t("activeSince")}>{formatWhen(app.activatedAt) ?? "—"}</Fact> : null}
          {app.signer || app.source === "upload" || app.runtime === "sandbox" ? (
            <Suspense fallback={null}>
              <AppRunFacts app={app} />
            </Suspense>
          ) : null}
        </AppListingFacts>
      </CardContent>
    </Card>
  );
}

/** What the app can reach now: its base and the features that are on. */
function Access({ app }: { app: AppDetail }) {
  const t = useMessages(installedAppsMessages);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("accessTitle")}</CardTitle>
        <CardDescription>{t(app.features.length > 0 ? "accessFeaturesDescription" : "accessDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        <AppAccess app={app} />
      </CardContent>
    </Card>
  );
}

/** The checkout points the app implements, in plain words, with its priority at each. */
function CheckoutFunctions({ functions }: { functions: AppFunction[] }) {
  const t = useMessages(installedAppsMessages);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("functionsTitle")}</CardTitle>
        <CardDescription>{t("functionsDescription")}</CardDescription>
      </CardHeader>
      <ul>
        {functions.map((fn) => (
          <li key={fn.point} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border px-4 py-3 text-body">
            {isKnownFunctionPoint(fn.point) ? <span>{t(`point_${fn.point}`)}</span> : <span className="font-mono">{fn.point}</span>}
            <span className="text-muted-foreground tabular-nums">{t("priority", { priority: fn.priority })}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** The app's own scheduled jobs (a feature's jobs show with the feature). */
function Jobs({ app, jobs }: { app: AppDetail; jobs: AppDetail["cron"] }) {
  const t = useMessages(installedAppsMessages);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("jobsTitle")}</CardTitle>
        <CardDescription>{t("jobsDescription")}</CardDescription>
      </CardHeader>
      <ul>
        {jobs.map((job) => {
          const run = job.lastRun;
          const when = run ? formatWhen(run.finishedAt ?? run.scheduledFor) : null;
          const took = run ? formatDuration(run.durationMs) : null;
          return (
            <li key={job.name} className="flex flex-col gap-1 border-t border-border px-4 py-3 text-body">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>{app.id === "scalius.bangladesh" ? providerLabel(job.name) : job.name}</span>
                {run ? <Badge variant={JOB_VARIANT[run.status]}>{t(`job_${run.status}`)}</Badge> : <Badge variant="secondary">{t("job_never")}</Badge>}
              </div>
              <p className="text-muted-foreground">
                {t("scheduleDeclared", { schedule: appJobScheduleText(job.schedule) })}
                {when ? ` · ${t("lastRun", { when })}` : null}
                {took ? ` · ${took}` : null}
              </p>
              <details className="text-muted-foreground">
                <summary className="cursor-pointer">{t("scheduleTechnical")}</summary>
                <code dir="ltr" translate="no" className="break-all">{job.schedule}</code>
              </details>
              {run?.error ? <p className="break-words text-destructive">{run.error}</p> : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** The page's last card: turn the app off, or uninstall it, each with what happens. */
function TurnOffCard({ app, onDialog }: { app: AppDetail; onDialog: (name: DialogName) => void }) {
  const t = useMessages(installedAppsMessages);
  const active = app.status === "active";
  const row = "flex flex-col items-start gap-3 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between";
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("turnOffTitle")}</CardTitle>
      </CardHeader>
      {active && app.thirdParty ? (
        <div className={row}>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-body font-medium">{t("stopLabel")}</span>
            <span className="text-body text-muted-foreground">{t("stopHelp")}</span>
          </div>
          <Suspense fallback={null}>
            <AppStopAction app={app} />
          </Suspense>
        </div>
      ) : null}
      {active ? (
        <div className={row}>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-body font-medium">{t("deactivate")}</span>
            <span className="text-body text-muted-foreground">{t("deactivateHelp")}</span>
          </div>
          <Button type="button" variant="outline" onClick={() => onDialog("deactivate")}>{t("deactivate")}</Button>
        </div>
      ) : null}
      <div className={row}>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-body font-medium">{t("uninstall")}</span>
          <span className="text-body text-muted-foreground">{t(app.runtime === "bundled" ? "uninstallHelpBundled" : "uninstallHelp")}</span>
        </div>
        <Button type="button" variant="outline" onClick={() => onDialog("uninstall")}>{t("uninstall")}</Button>
      </div>
    </Card>
  );
}

function AppPage({ app }: { app: AppDetail }) {
  const t = useMessages(installedAppsMessages);
  const { hasPermission, isSuperAdmin } = usePermissions();
  const canManage = hasPermission(ADMIN_PERMISSIONS.APPS_MANAGE);
  const [dialog, setDialog] = useState<DialogName>(null);
  const closeDialog = (open: boolean) => {
    if (!open) setDialog(null);
  };
  // One draft for every field on the page (services and the app's own), saved by the page's save bar.
  const form = useAppSettingsDraft(app, { canManage });
  const active = app.status === "active";
  const functions = checkoutFunctions(app.functions);
  const featureJobs = new Set(app.features.flatMap((feature) => feature.request.cron));
  const jobs = app.cron.filter((job) => !featureJobs.has(job.name));
  const missing = !active ? app.settings.fields.filter((field) => app.settings.missing.includes(field.key)) : [];
  // An update that needs approval leaves the app "installed" (paused), so this covers both.
  const canActivate = isSuperAdmin && !active;

  return (
    <Page width="detail">
      <PageHeader
        backTo="/admin/apps"
        title={(
          <span className="flex items-center gap-3">
            <AppIcon src={app.icon} />
            {app.name}
          </span>
        )}
        status={<AppStatusBadge app={app} />}
        meta={t("byline", { version: app.version, author: app.author.name })}
        primaryAction={canActivate ? (
          <Button type="button" disabled={!app.runtimeAvailable} onClick={() => setDialog("activate")}>
            {t(app.needsApproval ? "reviewUpdate" : "reviewActivate")}
          </Button>
        ) : undefined}
      />
      {!canManage ? <ReadOnlyNotice /> : null}
      <div className="flex flex-col gap-4">
        <SaveErrorBanner />
        {app.status === "failed" ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>{t("failedTitle")}</AlertTitle>
            <AlertDescription>{app.failureReason ?? t("failedBody")}</AlertDescription>
          </Alert>
        ) : null}
        {(app.status === "disabled" && app.failureReason) || (canManage && app.source !== "bundled") ? (
          <Suspense fallback={null}>
            <AppLifecycleNotices app={app} canManage={canManage} />
          </Suspense>
        ) : null}
        {app.needsApproval ? (
          <Alert variant="warning">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>{t("needsApprovalTitle")}</AlertTitle>
            <AlertDescription>{t("needsApprovalBody")}</AlertDescription>
          </Alert>
        ) : null}
        {!app.runtimeAvailable ? (
          <Alert variant="warning">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>{t("unavailableTitle")}</AlertTitle>
            <AlertDescription>{t(app.runtime === "bundled" ? "unavailable_bundled" : "unavailable_sandbox")}</AlertDescription>
          </Alert>
        ) : canManage && !active && !isSuperAdmin ? (
          <Alert variant="info">
            <AlertDescription>{t("superAdminActivates")}</AlertDescription>
          </Alert>
        ) : null}
        {missing.length > 0 ? (
          <Alert variant="warning">
            <AlertDescription>{t("missingBody", { settings: missing.map((field) => field.label).join(", ") })}</AlertDescription>
          </Alert>
        ) : null}
        <div className="grid items-start gap-4 lg:grid-cols-3">
          <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
            {app.screenshots.length > 0 ? (
              <Card>
                <CardContent className="pt-4">
                  <AppScreenshots app={app} />
                </CardContent>
              </Card>
            ) : null}
            <AppFeatures app={app} form={form} canManage={canManage} isSuperAdmin={isSuperAdmin} />
            <AppSettingsSections app={app} form={form} canManage={canManage} />
            <AppWhereItAppears app={app} />
            {functions.length > 0 ? <CheckoutFunctions functions={functions} /> : null}
            {jobs.length > 0 ? <Jobs app={app} jobs={jobs} /> : null}
            <AppActivity appId={app.id} canManage={canManage} />
            {canManage ? <TurnOffCard app={app} onDialog={setDialog} /> : null}
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <About app={app} />
            <Access app={app} />
          </div>
        </div>
      </div>

      {isSuperAdmin ? <ActivateAppDialog app={app} open={dialog === "activate"} onOpenChange={closeDialog} /> : null}
      {canManage ? (
        <>
          <DeactivateAppDialog app={app} open={dialog === "deactivate"} onOpenChange={closeDialog} />
          <UninstallAppDialog app={app} open={dialog === "uninstall"} onOpenChange={closeDialog} />
        </>
      ) : null}
    </Page>
  );
}

/**
 * The app page with its own save bar (every settings field on the page
 * registers with it) and the provider setup sheets its links can open.
 */
export function AppDetailPage({ app }: { app: AppDetail }) {
  const t = useMessages(installedAppsMessages);
  // The app's name, description, page titles, features and settings in the dashboard's language.
  const locale = useLocale();
  return (
    <SaveBarProvider savedMessage={t("settingsSaved")}>
      <AppProviderSheetHost>
        <AppPage app={localizedAppDetail(app, locale)} />
      </AppProviderSheetHost>
    </SaveBarProvider>
  );
}
