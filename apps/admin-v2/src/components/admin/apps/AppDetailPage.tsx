// One installed app (Shopify's app details). The header names it with its
// status and the one thing to do next (activate, or approve an update). An
// app with features is a small section shell, like the dashboard's own
// Settings: an Overview (what is running, what it is, what it can reach,
// where it appears, turning it off), one page per feature under its kind
// (its switch, consent, setup and health), the app's own Settings and its
// Activity, each at /admin/apps/<app>/<section>. An app without features
// stays one page. Edits are drafts saved by the page's save bar; a feature's
// switch applies at once after its own confirmation. Everything is drawn from
// the API's description of the app; no app code runs in the dashboard. A
// Super Admin activates (or approves an update) and turns features on;
// managers change settings, turn features off, deactivate and uninstall.
import { lazy, Suspense, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, CircleAlert, TriangleAlert } from "lucide-react";
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
import { AppFeatures, HealthBadge } from "./AppFeatures";
import { AppFeatureSection } from "./AppFeatureSection";
import { AppSectionNav } from "./AppSectionNav";
import { appSectionNav, appSectionPath, resolveAppSection, usesSections, type AppSection } from "./app-sections";
import { SERVICE_HEALTH, serviceSettingKeys } from "./app-services";
import { appFeaturesMessages } from "~/i18n/app-features";
import { checkoutFunctions, isKnownFunctionPoint } from "./app-functions";
import { AppActivity } from "./AppActivity";
import { AppIcon } from "./AppIcon";
import { AppListingFacts, AppScreenshots, Fact } from "./AppListingParts";
import { ActivateAppDialog, DeactivateAppDialog, UninstallAppDialog } from "./AppDialogs";
import { useAppSettingsDraft } from "./AppSettingsForm";
import { AppSettingsSections } from "./AppSettingsSections";
import { AppWhereItAppears } from "./AppWhereItAppears";
import { AppStatusBadge } from "./app-status";
import { StorefrontProblemNotice } from "./StorefrontProblemNotice";
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
  // An app compiled into this deployment that never ran has nothing to turn off, and
  // uninstalling it only lists it again as installed: no card to offer either.
  if (!active && app.runtime === "bundled" && app.activatedAt === null) return null;
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

type FeatureSection = Extract<AppSection, { kind: "feature" }>;

/** How urgent a running service's state is (`SERVICE_HEALTH`): not working, needs setup, set up but unused, ready. */
const healthRank = (section: FeatureSection) => (section.health ? SERVICE_HEALTH[section.health.status].rank : SERVICE_HEALTH.ready.rank);

/** One service as a link to its own page, with how it is doing (or that it is off). */
function ServiceRow({ app, section }: { app: AppDetail; section: FeatureSection }) {
  const t = useMessages(appFeaturesMessages);
  const { feature } = section;
  return (
    <li>
      <Link
        to={appSectionPath(app.id, section.key)}
        className="flex min-h-12 items-center gap-3 px-4 py-2 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <AppIcon src={feature.request.providers[0]?.icon ?? app.icon} size="sm" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body font-medium" title={feature.name}>{feature.name}</span>
          <span className="truncate text-body text-muted-foreground">{t(`group_${section.group}`)}</span>
        </span>
        {feature.enabled ? <HealthBadge health={section.health} /> : <span className="shrink-0 text-body text-muted-foreground">{t("off")}</span>}
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Link>
    </li>
  );
}

/**
 * Overview's first card, the health summary: how many services are on and
 * how they are doing, then the ones that are on, problems first, each a link
 * to its page. The ones that are off live in the section column, so one line
 * here counts them instead of listing them twice. Below 1024px the column is
 * a picker, so the card lists them there too, under "Off".
 */
function ServicesSummary({ app }: { app: AppDetail }) {
  const t = useMessages(appFeaturesMessages);
  const features = appSectionNav(app)
    .flatMap((entry) => entry.sections)
    .filter((section): section is FeatureSection => section.kind === "feature");
  const on = features
    .filter((section) => section.feature.enabled)
    .map((section, index) => ({ section, index }))
    .sort((a, b) => healthRank(a.section) - healthRank(b.section) || a.index - b.index)
    .map(({ section }) => section);
  const off = features.filter((section) => !section.feature.enabled);
  const problems = on.filter((section) => healthRank(section) < SERVICE_HEALTH.ready.rank).length;
  const summary = on.length === 0 ? t("servicesNoneOn")
    : problems > 0 ? t("servicesProblems", { count: problems })
      : t("servicesWorking");
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>{t("servicesTitle")}</CardTitle>
          <Badge variant="secondary">{t("servicesCount", { on: on.length, total: features.length })}</Badge>
        </div>
        <CardDescription>{summary}</CardDescription>
      </CardHeader>
      {on.length > 0 ? (
        <ul className="border-t border-border py-2">
          {on.map((section) => <ServiceRow key={section.key} app={app} section={section} />)}
        </ul>
      ) : null}
      {off.length > 0 ? (
        <>
          <p className="border-t border-border px-4 py-3 text-body text-muted-foreground">
            {t(on.length === 0 ? "servicesAllOff" : "servicesOff", { count: off.length })}
          </p>
          <section aria-labelledby="services-off" data-slot="services-off" className="border-t border-border lg:hidden">
            <h3 id="services-off" className="px-4 pb-1 pt-3 text-body font-medium text-muted-foreground">{t("servicesOffTitle")}</h3>
            <ul className="pb-2">
              {off.map((section) => <ServiceRow key={section.key} app={app} section={section} />)}
            </ul>
          </section>
        </>
      ) : null}
    </Card>
  );
}

/** The app's own settings (no feature's): one draft, saved by the page's save bar. */
function SettingsSection({ app, canManage }: { app: AppDetail; canManage: boolean }) {
  const owned = serviceSettingKeys(app);
  const keys = app.settings.fields.map((field) => field.key).filter((key) => !owned.has(key));
  const form = useAppSettingsDraft(app, { canManage, keys });
  return <AppSettingsSections app={app} form={form} canManage={canManage} />;
}

/** The app's checkout functions and its own jobs (a feature's jobs show on its page). */
function AppMore({ app }: { app: AppDetail }) {
  const functions = checkoutFunctions(app.functions);
  const featureJobs = new Set(app.features.flatMap((feature) => feature.request.cron));
  const jobs = app.cron.filter((job) => !featureJobs.has(job.name));
  return (
    <>
      {functions.length > 0 ? <CheckoutFunctions functions={functions} /> : null}
      {jobs.length > 0 ? <Jobs app={app} jobs={jobs} /> : null}
    </>
  );
}

function Screenshots({ app }: { app: AppDetail }) {
  if (app.screenshots.length === 0) return null;
  return (
    <Card>
      <CardContent className="pt-4">
        <AppScreenshots app={app} />
      </CardContent>
    </Card>
  );
}

interface PageProps {
  app: AppDetail;
  canManage: boolean;
  isSuperAdmin: boolean;
  onDialog: (name: DialogName) => void;
}

/** An app without features, on one page: its services (providers that run with it), its settings and the rest. */
function SinglePage({ app, canManage, isSuperAdmin, onDialog }: PageProps) {
  // One draft for every field on the page (services and the app's own), saved by the page's save bar.
  const form = useAppSettingsDraft(app, { canManage });
  return (
    <div className="grid items-start gap-4 lg:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
        <Screenshots app={app} />
        <AppFeatures app={app} form={form} canManage={canManage} isSuperAdmin={isSuperAdmin} />
        <AppSettingsSections app={app} form={form} canManage={canManage} />
        <AppWhereItAppears app={app} />
        <AppMore app={app} />
        <AppActivity appId={app.id} canManage={canManage} />
        {canManage ? <TurnOffCard app={app} onDialog={onDialog} /> : null}
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <About app={app} />
        <Access app={app} />
      </div>
    </div>
  );
}

/** One section of an app with features. */
function SectionContent({ app, section, canManage, isSuperAdmin, onDialog }: PageProps & { section: AppSection }) {
  switch (section.kind) {
    case "feature":
      return <AppFeatureSection key={section.key} app={app} feature={section.feature} health={section.health} canManage={canManage} isSuperAdmin={isSuperAdmin} />;
    case "settings":
      return <SettingsSection app={app} canManage={canManage} />;
    case "activity":
      return <AppActivity appId={app.id} canManage={canManage} always />;
    default:
      return (
        <>
          <ServicesSummary app={app} />
          <About app={app} />
          <Screenshots app={app} />
          <Access app={app} />
          <AppWhereItAppears app={app} />
          <AppMore app={app} />
          {canManage ? <TurnOffCard app={app} onDialog={onDialog} /> : null}
        </>
      );
  }
}

function AppPage({ app, section }: { app: AppDetail; section: AppSection }) {
  const t = useMessages(installedAppsMessages);
  const { hasPermission, isSuperAdmin } = usePermissions();
  const canManage = hasPermission(ADMIN_PERMISSIONS.APPS_MANAGE);
  const [dialog, setDialog] = useState<DialogName>(null);
  const closeDialog = (open: boolean) => {
    if (!open) setDialog(null);
  };
  const active = app.status === "active";
  const pageProps: PageProps = { app, canManage, isSuperAdmin, onDialog: setDialog };
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
        {/* A storefront part the store drew without lately: what, why and what shoppers saw. */}
        {active ? <StorefrontProblemNotice appId={app.id} link={false} /> : null}
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
        {app.storefront.themeProblems.length > 0 ? (
          <Alert variant="warning" data-slot="theme-problems">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>{t("themeProblemsTitle")}</AlertTitle>
            <AlertDescription>
              <p>{t("themeProblemsBody")}</p>
              <ul className="mt-1 flex flex-col gap-1">
                {app.storefront.themeProblems.map((entry) => (
                  <li key={`${entry.kind}:${entry.id}`}>
                    <span className="block font-medium">{t(`themeProblem_${entry.kind}`, { name: entry.name })}</span>
                    {/* The developer's reason, as the platform states it. */}
                    <span className="block text-muted-foreground" lang="en">{entry.problem}</span>
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}
        {usesSections(app) ? (
          <div className="grid items-start gap-4 lg:grid-cols-4">
            <AppSectionNav app={app} current={section.key} />
            <div className="flex min-w-0 flex-col gap-4 lg:col-span-3">
              <SectionContent {...pageProps} section={section} />
            </div>
          </div>
        ) : (
          <SinglePage {...pageProps} />
        )}
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
 * The app page with its own save bar: every settings field of the section on
 * screen registers with it, and leaving the section with unsaved edits asks
 * first. `sectionKey` is the section's path segment (the overview without
 * one); the route sends unknown or provider-named segments to their section.
 */
export function AppDetailPage({ app, sectionKey }: { app: AppDetail; sectionKey?: string }) {
  const t = useMessages(installedAppsMessages);
  // The app's name, description, page titles, features and settings in the dashboard's language.
  const locale = useLocale();
  const localized = localizedAppDetail(app, locale);
  const section: AppSection = resolveAppSection(localized, sectionKey) ?? { kind: "overview", key: "overview" };
  return (
    <SaveBarProvider savedMessage={t("settingsSaved")}>
      <AppPage app={localized} section={section} />
    </SaveBarProvider>
  );
}
