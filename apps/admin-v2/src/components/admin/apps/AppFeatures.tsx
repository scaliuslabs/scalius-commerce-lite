// An app's services on its page, one card per kind (Shopify's payment
// providers card): each feature with its switch, and each provider that runs
// with the app. A row says what it does and what access it needs; while it
// runs, its own settings sit under it (saved with the page's save bar), with
// where it is chosen, its pages and how it is doing. Turning a feature on is
// a Super Admin's consent to that feature's access alone (its grant key goes
// back with it); turning one off says what stops. Everything comes from the
// API's description of the app; no app code runs here.
import { useEffect, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { formatList } from "@scalius/shared/locale-words";
import { toast } from "~/lib/toast";
import { ListDate } from "~/components/admin/data-table/ListDate";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { FieldGroup, Inset } from "~/components/ui/field";
import { Switch } from "~/components/ui/switch";
import { getLocale, useMessages } from "~/i18n";
import { appFeaturesMessages } from "~/i18n/app-features";
import { appScopeMessages } from "~/i18n/app-scopes";
import { installedAppsMessages } from "~/i18n/apps";
import { settingsNavMessages } from "~/i18n/settings";
import { APP_FUNCTION_POINTS, disableAppFeature, enableAppFeature, type AppDetail, type AppFeature } from "~/lib/api-query-options/apps";
import { topicLabel } from "../settings/webhooks/webhook-format";
import { PROVIDER_CAPABILITY, isAppProviderKind } from "./app-capabilities";
import {
  featureGroup,
  featureProviders,
  itemSettingKeys,
  lastJobRun,
  serviceGroups,
  serviceHealth,
  type ServiceHealth,
  type ServiceItem,
} from "./app-services";
import { useAppMutationResult } from "./AppDialogs";
import { AppIcon } from "./AppIcon";
import { AppSettingControl, settingFieldId, type AppSettingsDraftApi } from "./AppSettingsForm";
import { appPagePath } from "./ui/surfaces";

const HEALTH_VARIANT = { ready: "success", setup: "warning", error: "destructive" } as const;

function isFunctionPoint(point: string): point is (typeof APP_FUNCTION_POINTS)[number] {
  return (APP_FUNCTION_POINTS as readonly string[]).includes(point);
}

/** One line of what a feature needs beyond the app, in plain words ("Connects to 2 websites"). */
export function useAccessLine(feature: AppFeature): string {
  const t = useMessages(appFeaturesMessages);
  const scopeText = useMessages(appScopeMessages);
  const { request } = feature;
  const parts = [
    ...request.scopes.map((scope) => scopeText(`scope_${scope.name}`)),
    ...(request.allowedHosts.length > 2
      ? [t("accessHostCount", { count: request.allowedHosts.length })]
      : request.allowedHosts.length > 0 ? [t("accessHosts", { hosts: formatList(request.allowedHosts, getLocale()) })] : []),
    ...(request.functions.length > 0 ? [t("accessCheckout")] : []),
    ...(request.events.length > 0 ? [t("accessEvents", { count: request.events.length })] : []),
  ];
  return parts.length > 0 ? parts.join(" · ") : t("accessNone");
}

/** Whether turning the feature on asks for anything beyond the app (the items `FeatureAccess` lists). */
export function hasFeatureAccess({ request }: AppFeature): boolean {
  return request.scopes.length > 0 || request.providers.length > 0 || request.functions.length > 0 || request.events.length > 0
    || request.publicRoutes || request.cron.length > 0 || request.admin || request.storefront || request.allowedHosts.length > 0;
}

/** Everything turning a feature on allows, as the consent list: only its own part, never the app's base. */
export function FeatureAccess({ feature }: { feature: AppFeature }) {
  const t = useMessages(appFeaturesMessages);
  const apps = useMessages(installedAppsMessages);
  const scopeText = useMessages(appScopeMessages);
  const { request } = feature;
  const kinds = [...new Set(request.providers.map((provider) => provider.kind))];
  const items: Array<{ key: string; content: ReactNode }> = [
    ...request.scopes.map((scope) => ({
      key: `scope:${scope.name}`,
      content: (
        <span className="flex flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {scopeText(`scope_${scope.name}`)}
            {scope.sensitive ? <Badge variant="attention">{apps("sensitive")}</Badge> : null}
          </span>
          <span className="text-muted-foreground">{scopeText(`scope_${scope.name}_help`)}</span>
        </span>
      ),
    })),
    ...kinds.map((kind) => ({ key: `kind:${kind}`, content: apps(`provider_${kind}`) })),
    ...request.functions.map((point) => ({ key: `fn:${point}`, content: isFunctionPoint(point) ? apps(`function_${point}`) : point })),
    ...(request.events.length > 0 ? [{ key: "events", content: t("access_events", { topics: formatList(request.events.map(topicLabel), getLocale()) }) }] : []),
    ...(request.publicRoutes ? [{ key: "public", content: t("access_publicRoutes") }] : []),
    ...(request.cron.length > 0 ? [{ key: "cron", content: t("access_jobs") }] : []),
    ...(request.admin ? [{ key: "admin", content: t("access_admin") }] : []),
    ...(request.storefront ? [{ key: "storefront", content: t("access_storefront") }] : []),
    ...request.allowedHosts.map((host) => {
      // "Connect to {host}", with the host as code wherever the language puts it.
      const [before, after] = t("access_host", { host: "\u0000" }).split("\u0000");
      return { key: `host:${host}`, content: <span className="wrap-anywhere">{before}<code>{host}</code>{after}</span> };
    }),
  ];
  if (!hasFeatureAccess(feature)) return <p className="text-body text-muted-foreground">{t("noExtraAccess")}</p>;
  return (
    <ul className="flex list-disc flex-col gap-1.5 ps-5 text-body">
      {items.map((item) => <li key={item.key}>{item.content}</li>)}
    </ul>
  );
}

interface FeatureDialogProps {
  app: AppDetail;
  feature: AppFeature;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** A Super Admin's consent to one feature: what it does, what it may then do, and Turn on. */
export function EnableFeatureDialog({ app, feature, open, onOpenChange, onEnabled }: FeatureDialogProps & { onEnabled: () => void }) {
  const t = useMessages(appFeaturesMessages);
  const result = useAppMutationResult(app);
  const enable = useMutation({
    mutationFn: () => enableAppFeature(app, feature),
    onSuccess: ({ app: next, hookError }) => {
      result.applied(next, hookError, t("enabled", { name: feature.name }));
      onOpenChange(false);
      onEnabled();
    },
    onError: (error) => {
      if (result.changed(error)) return;
      toast.error(t("enableFailed", { name: feature.name }));
    },
  });
  return (
    <Dialog open={open} onOpenChange={(next) => (enable.isPending ? undefined : onOpenChange(next))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("enableTitle", { name: feature.name })}</DialogTitle>
          <DialogDescription>{feature.description}</DialogDescription>
        </DialogHeader>
        {/* Nothing listed: one sentence says so, never a "can:" list and a consent to nothing. */}
        {hasFeatureAccess(feature) ? (
          <>
            <div className="flex flex-col gap-2">
              <p className="text-body font-medium">{t("enableWill", { app: app.name, name: feature.name })}</p>
              <FeatureAccess feature={feature} />
            </div>
            <p className="text-body text-muted-foreground">{t("enableConsent", { app: app.name, name: feature.name })}</p>
          </>
        ) : (
          <p className="text-body text-muted-foreground">{t("noExtraAccessFor", { app: app.name, name: feature.name })}</p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={enable.isPending} onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button type="button" loading={enable.isPending} onClick={() => enable.mutate()}>
            {t("enable")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Turning a feature off, with what stops for the store. */
export function DisableFeatureDialog({ app, feature, open, onOpenChange }: FeatureDialogProps) {
  const t = useMessages(appFeaturesMessages);
  const result = useAppMutationResult(app);
  const group = featureGroup(feature);
  const disable = useMutation({
    mutationFn: () => disableAppFeature(app, feature.id),
    onSuccess: ({ app: next, hookError }) => {
      result.applied(next, hookError, t("disabled", { name: feature.name }));
      onOpenChange(false);
    },
    onError: (error) => {
      if (result.changed(error)) return;
      toast.error(t("disableFailed", { name: feature.name }));
    },
  });
  return (
    <AlertDialog open={open} onOpenChange={(next) => (disable.isPending ? undefined : onOpenChange(next))}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("disableTitle", { name: feature.name })}</AlertDialogTitle>
          <AlertDialogDescription>
            {group === "other" ? null : `${t(`disableEffect_${group}`)} `}
            {t("disableBody", { app: app.name, name: feature.name })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={disable.isPending}>{t("cancel")}</AlertDialogCancel>
          <Button type="button" variant="destructive" loading={disable.isPending} onClick={() => disable.mutate()}>
            {t("disable")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function HealthBadge({ health }: { health: ServiceHealth }) {
  const t = useMessages(appFeaturesMessages);
  if (!health) return null;
  return <Badge variant={HEALTH_VARIANT[health.status]}>{t(`status_${health.status}`)}</Badge>;
}

/**
 * What a running service shows: its settings, where it is chosen, its pages
 * and its last run. Under its row in a services card (`inRow`, a quiet
 * inset), or as the body of its own page.
 */
export function RunningDetail({ app, item, form, canManage, health, inRow = true }: {
  app: AppDetail;
  item: ServiceItem;
  form: AppSettingsDraftApi;
  canManage: boolean;
  health: ServiceHealth;
  inRow?: boolean;
}) {
  const t = useMessages(appFeaturesMessages);
  const settingsPage = useMessages(settingsNavMessages);
  const keys = itemSettingKeys(app, item);
  const fields = app.settings.fields.filter((field) => keys.includes(field.key));
  const providers = item.kind === "feature" ? featureProviders(app, item.feature) : [item.provider];
  const capabilities = [...new Map(providers.flatMap((provider) => (isAppProviderKind(provider.kind) ? [[provider.kind, PROVIDER_CAPABILITY[provider.kind]] as const] : []))).values()];
  const pages = item.kind === "feature" ? app.admin.pages.filter((page) => item.feature.pages.includes(page.id)) : [];
  const lastRun = item.kind === "feature" ? lastJobRun(app, item.feature) : null;
  const active = app.status === "active";
  const links = [
    ...capabilities.map((capability) => (
      <Link key={capability.to} to={capability.to} className="text-link hover:underline">{t("chooseIn", { page: settingsPage(capability.page) })}</Link>
    )),
    ...(active ? pages.map((page) => (
      <Link key={page.id} to={appPagePath(app.id, page.id)} className="text-link hover:underline">{t("openPage", { title: page.title })}</Link>
    )) : []),
  ];
  const body = (
      <div className="flex flex-col gap-3">
        {fields.length > 0 ? (
          <FieldGroup inset={inRow}>
            {fields.map((field) => <AppSettingControl key={field.key} app={app} field={field} form={form} canManage={canManage} />)}
          </FieldGroup>
        ) : links.length === 0 ? <p className="text-body text-muted-foreground">{t("noSettings")}</p> : null}
        {links.length > 0 ? <div className="flex flex-col items-start gap-1 text-body">{links}</div> : null}
        {health?.status === "error" ? (
          <p className="text-body text-destructive wrap-anywhere">
            {t("failedRun")} <ListDate value={health.at} className="text-destructive" />{health.error ? `: ${health.error}` : null}
          </p>
        ) : lastRun ? (
          <p className="text-body text-muted-foreground">{t("lastRan")} <ListDate value={lastRun} /></p>
        ) : null}
      </div>
  );
  return inRow ? <Inset className="mt-3 sm:ms-11">{body}</Inset> : body;
}

function ServiceRow({ app, item, form, canManage, canTurnOn, focus, onToggle }: {
  app: AppDetail;
  item: ServiceItem;
  form: AppSettingsDraftApi;
  canManage: boolean;
  canTurnOn: boolean;
  /** Just turned on: its first setting takes the focus. */
  focus: boolean;
  onToggle: () => void;
}) {
  const t = useMessages(appFeaturesMessages);
  const feature = item.kind === "feature" ? item.feature : null;
  const running = feature ? feature.enabled : app.status === "active";
  const name = feature ? feature.name : item.kind === "provider" ? item.provider.name : "";
  const icon = feature ? feature.request.providers[0]?.icon ?? app.icon : item.kind === "provider" ? item.provider.icon : null;
  const health = serviceHealth(app, item);
  const describedBy = `app-service-${item.id.replace(/[^a-z0-9-]/gi, "-")}`;
  const firstKey = itemSettingKeys(app, item)[0];
  useEffect(() => {
    if (focus && running && firstKey) document.getElementById(settingFieldId(firstKey))?.focus();
  }, [focus, running, firstKey]);
  return (
    <li className="border-t border-border px-4 py-3">
      <div className="flex items-start gap-3">
        <AppIcon src={icon} size="sm" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-body font-medium">{name}</span>
            {feature?.recommended && !feature.enabled ? <Badge variant="info">{t("recommended")}</Badge> : null}
            <HealthBadge health={health} />
          </div>
          {feature ? <FeatureText feature={feature} describedBy={describedBy} /> : null}
        </div>
        {feature ? (
          <span className="flex h-lh items-center text-body">
            <Switch
              checked={feature.enabled}
              disabled={feature.enabled ? !canManage : !canTurnOn}
              onCheckedChange={onToggle}
              aria-label={t("toggleLabel", { name })}
              aria-describedby={describedBy}
            />
          </span>
        ) : null}
      </div>
      {running ? <RunningDetail app={app} item={item} form={form} canManage={canManage} health={health} /> : null}
    </li>
  );
}

function FeatureText({ feature, describedBy }: { feature: AppFeature; describedBy: string }) {
  const t = useMessages(appFeaturesMessages);
  const access = useAccessLine(feature);
  return (
    <>
      <p id={describedBy} className="text-body text-muted-foreground">{feature.description}</p>
      <p className="text-body text-muted-foreground wrap-anywhere">
        <span className="font-medium">{t("accessLabel")}</span> {access}
      </p>
    </>
  );
}

/**
 * The app's services, one card per kind. `form` is the page's settings
 * draft (the rows' fields save with the page). `canManage`: may change
 * settings and turn features off; `isSuperAdmin`: may also turn them on.
 */
export function AppFeatures({ app, form, canManage, isSuperAdmin }: {
  app: AppDetail;
  form: AppSettingsDraftApi;
  canManage: boolean;
  isSuperAdmin: boolean;
}) {
  const t = useMessages(appFeaturesMessages);
  // The last feature asked about stays in its dialog while the dialog closes.
  const [target, setTarget] = useState<AppFeature | null>(null);
  const [turn, setTurn] = useState<"on" | "off" | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const groups = serviceGroups(app);
  if (groups.length === 0) return null;
  const active = app.status === "active";
  const canTurnOn = active && isSuperAdmin && app.runtimeAvailable;
  const note = app.features.length === 0 ? null : !active ? t("activateFirst") : canManage && !isSuperAdmin ? t("superAdminTurnsOn") : null;
  const close = (open: boolean) => {
    if (!open) setTurn(null);
  };
  return (
    <>
      {groups.map(({ group, items }, index) => (
        <Card key={group}>
          <CardHeader>
            <CardTitle>{t(`group_${group}`)}</CardTitle>
            {index === 0 && note ? <CardDescription role="status">{note}</CardDescription> : null}
          </CardHeader>
          <ul>
            {items.map((item) => (
              <ServiceRow
                key={item.id}
                app={app}
                item={item}
                form={form}
                canManage={canManage}
                canTurnOn={canTurnOn}
                focus={item.kind === "feature" && focused === item.feature.id}
                onToggle={() => {
                  if (item.kind !== "feature") return;
                  setTarget(item.feature);
                  setTurn(item.feature.enabled ? "off" : "on");
                }}
              />
            ))}
          </ul>
        </Card>
      ))}
      {target ? (
        <EnableFeatureDialog app={app} feature={target} open={turn === "on"} onOpenChange={close} onEnabled={() => setFocused(target.id)} />
      ) : null}
      {target ? <DisableFeatureDialog app={app} feature={target} open={turn === "off"} onOpenChange={close} /> : null}
    </>
  );
}
