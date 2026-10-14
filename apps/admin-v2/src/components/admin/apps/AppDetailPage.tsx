// One installed app (Shopify's app details), in three tabs. Overview: what it
// is (tagline, description, screenshots, developer, categories, countries,
// links, version and changelog), its features (each turned on by itself,
// with its own consent), where it appears, its checkout functions,
// scheduled jobs and activity. Settings: its app-wide settings in their
// sections, and each service it offers as a collapsed group. Permissions:
// what it may do. Everything is drawn from the API's description of the
// app; no app code runs in the dashboard. A Super Admin activates (or
// approves an update); managers change settings, deactivate and uninstall.
import { lazy, Suspense, useState } from "react";
import { ChevronDown, CircleAlert, TriangleAlert } from "lucide-react";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { SaveBarProvider, SaveErrorBanner } from "~/components/admin/shared/SaveBar";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { usePermissions } from "~/contexts/PermissionContext";
import { useLocale, useMessages } from "~/i18n";
import { providerLabel } from "~/i18n/provider-copy";
import { installedAppsMessages } from "~/i18n/apps";
import { localizedAppDetail } from "./app-detail-text";
import { resourceMessages } from "~/i18n/resource";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import type { AppDetail, AppFunction } from "~/lib/api-query-options/apps";
import { formatDuration, formatWhen } from "../settings/webhooks/webhook-format";
import { AppAccess } from "./AppAccess";
import { AppFeatureAccess, AppFeatures } from "./AppFeatures";
import { checkoutFunctions, isKnownFunctionPoint } from "./app-functions";
import { AppActivity } from "./AppActivity";
import { AppIcon } from "./AppIcon";
import { AppListingFacts, AppScreenshots, Fact } from "./AppListingParts";
import { ActivateAppDialog, DeactivateAppDialog, UninstallAppDialog } from "./AppDialogs";
import { appSurfacesMessages } from "~/i18n/app-surfaces";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { APP_PAGE_TABS, type AppPageTab } from "./app-page-tabs";
import { AppProviderSheetHost } from "./AppProviderSheetHost";
import { AppSettingsTab } from "./AppSettingsTab";
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

/** Shopify's app details: what it is (tagline, description, screenshots), then the listing's facts and this install's. */
function Overview({ app }: { app: AppDetail }) {
  const t = useMessages(installedAppsMessages);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("overviewTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {app.tagline ? <p className="text-body font-medium">{app.tagline}</p> : null}
        {app.description ? <p className="whitespace-pre-wrap break-words text-body">{app.description}</p> : null}
        <AppScreenshots app={app} />
        <AppListingFacts app={app}>
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

/** The checkout points the app implements, in plain words, with its priority at each. */
function CheckoutFunctions({ functions }: { functions: AppFunction[] }) {
  const t = useMessages(installedAppsMessages);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("functionsTitle")}</CardTitle>
        <CardDescription>{t("functionsDescription")}</CardDescription>
      </CardHeader>
      <ul className="border-t border-border">
        {functions.map((fn) => (
          <li key={fn.point} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border px-4 py-3 text-body first:border-t-0">
            {isKnownFunctionPoint(fn.point) ? <span>{t(`point_${fn.point}`)}</span> : <span className="font-mono">{fn.point}</span>}
            <span className="text-muted-foreground tabular-nums">{t("priority", { priority: fn.priority })}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Jobs({ app }: { app: AppDetail }) {
  const t = useMessages(installedAppsMessages);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("jobsTitle")}</CardTitle>
        <CardDescription>{t("jobsDescription")}</CardDescription>
      </CardHeader>
      <ul className="border-t border-border">
        {app.cron.map((job) => {
          const run = job.lastRun;
          const when = run ? formatWhen(run.finishedAt ?? run.scheduledFor) : null;
          const took = run ? formatDuration(run.durationMs) : null;
          return (
            <li key={job.name} className="space-y-1 border-t border-border px-4 py-3 text-body first:border-t-0">
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

function AppPage({ app, tab, onTab }: { app: AppDetail; tab: AppPageTab; onTab: (tab: AppPageTab) => void }) {
  const t = useMessages(installedAppsMessages);
  const tabs = useMessages(appSurfacesMessages);
  const r = useMessages(resourceMessages);
  const { hasPermission, isSuperAdmin } = usePermissions();
  const canManage = hasPermission(ADMIN_PERMISSIONS.APPS_MANAGE);
  const [dialog, setDialog] = useState<DialogName>(null);
  const closeDialog = (open: boolean) => {
    if (!open) setDialog(null);
  };
  const active = app.status === "active";
  const functions = checkoutFunctions(app.functions);
  // An update that needs approval leaves the app "installed" (paused), so this covers both.
  const canActivate = isSuperAdmin && !active;
  // Why there's nothing to press: no access to change apps, or activation is a Super Admin's.
  const note = !canManage ? "readOnly" : !active && !app.needsApproval && !isSuperAdmin ? "superAdminActivates" : null;

  const actions = (
    <>
      {canManage && active ? (
        <Suspense fallback={null}>
          <AppStopAction app={app} />
        </Suspense>
      ) : null}
      {canManage ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline">
              {r("moreActions")}
              <ChevronDown className="size-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {active ? <DropdownMenuItem onSelect={() => setDialog("deactivate")}>{t("deactivate")}</DropdownMenuItem> : null}
            <DropdownMenuItem variant="destructive" onSelect={() => setDialog("uninstall")}>{t("uninstall")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {canActivate ? (
        <Button type="button" disabled={!app.runtimeAvailable} onClick={() => setDialog("activate")}>
          {t(app.needsApproval ? "reviewUpdate" : "reviewActivate")}
        </Button>
      ) : null}
    </>
  );

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        backTo="/admin/apps"
        title={(
          <span className="flex items-center gap-3">
            <AppIcon src={app.icon} />
            {app.name}
          </span>
        )}
        status={<AppStatusBadge app={app} />}
        actions={actions}
      />
      <div className="space-y-4">
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
        ) : null}
        {note ? <p role="status" className="rounded-lg bg-muted px-4 py-2 text-body text-muted-foreground">{t(note)}</p> : null}
        <Tabs value={tab} onValueChange={(value) => onTab(value as AppPageTab)}>
          <TabsList aria-label={tabs("tabsLabel")}>
            {APP_PAGE_TABS.map((value) => <TabsTrigger key={value} value={value}>{tabs(`tab_${value}`)}</TabsTrigger>)}
          </TabsList>
          {/* Every tab stays mounted: unsaved settings survive a look at another tab. */}
          <TabsContent value="overview" forceMount className="space-y-4 data-[state=inactive]:hidden">
            <Overview app={app} />
            <AppFeatures app={app} canManage={canManage} isSuperAdmin={isSuperAdmin} />
            <AppWhereItAppears app={app} />
            {functions.length > 0 ? <CheckoutFunctions functions={functions} /> : null}
            {app.cron.length > 0 ? <Jobs app={app} /> : null}
            <AppActivity appId={app.id} canManage={canManage} />
          </TabsContent>
          <TabsContent value="settings" forceMount className="data-[state=inactive]:hidden">
            <AppSettingsTab app={app} canManage={canManage} />
          </TabsContent>
          <TabsContent value="permissions" forceMount className="space-y-4 data-[state=inactive]:hidden">
            <Card>
              <CardHeader>
                <CardTitle>{t("accessTitle")}</CardTitle>
                <CardDescription>{t("accessDescription")}</CardDescription>
              </CardHeader>
              <CardContent>
                <AppAccess app={app} />
              </CardContent>
            </Card>
            <AppFeatureAccess app={app} />
          </TabsContent>
        </Tabs>
      </div>

      {isSuperAdmin ? <ActivateAppDialog app={app} open={dialog === "activate"} onOpenChange={closeDialog} /> : null}
      {canManage ? (
        <>
          <DeactivateAppDialog app={app} open={dialog === "deactivate"} onOpenChange={closeDialog} />
          <UninstallAppDialog app={app} open={dialog === "uninstall"} onOpenChange={closeDialog} />
        </>
      ) : null}
    </div>
  );
}

/**
 * The app page with its own save bar (the Settings tab registers with it)
 * and the service setup sheets its Settings tab opens.
 */
export function AppDetailPage({ app, tab = "overview", onTab }: { app: AppDetail; tab?: AppPageTab; onTab?: (tab: AppPageTab) => void }) {
  const t = useMessages(installedAppsMessages);
  // The route keeps the tab in the address; without one the page keeps it itself.
  const [own, setOwn] = useState<AppPageTab>(tab);
  // The app's name, description, page titles and settings in the dashboard's language.
  const locale = useLocale();
  return (
    <SaveBarProvider savedMessage={t("settingsSaved")}>
      <AppProviderSheetHost>
        <AppPage app={localizedAppDetail(app, locale)} tab={onTab ? tab : own} onTab={onTab ?? setOwn} />
      </AppProviderSheetHost>
    </SaveBarProvider>
  );
}
