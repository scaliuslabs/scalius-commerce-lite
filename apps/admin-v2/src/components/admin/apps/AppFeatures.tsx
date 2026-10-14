// An app's features (`manifest.features`): the parts a merchant turns on one
// at a time. Each starts off. Turning one on is a Super Admin's consent to
// that feature's own access, listed in plain words and sent back with its
// grant key; turning one off revokes it (anyone who manages apps). The
// Permissions tab reuses the access list to show what each feature could
// reach. Everything comes from the API's description of the app.
import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "~/lib/toast";
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Switch } from "~/components/ui/switch";
import { useMessages } from "~/i18n";
import { appFeaturesMessages } from "~/i18n/app-features";
import { appScopeMessages } from "~/i18n/app-scopes";
import { installedAppsMessages } from "~/i18n/apps";
import { disableAppFeature, enableAppFeature, type AppDetail, type AppFeature } from "~/lib/api-query-options/apps";
import { topicLabel } from "../settings/webhooks/webhook-format";
import { useAppMutationResult } from "./AppDialogs";
import { RISK_VARIANT } from "./app-status";

/** The groups features are listed in, by the kind of service they provide. */
const FEATURE_GROUPS = ["payment", "courier", "sms", "fraud", "other"] as const;
type FeatureGroup = (typeof FEATURE_GROUPS)[number];

export function featureGroup(feature: Pick<AppFeature, "request">): FeatureGroup {
  const kind = feature.request.providers[0]?.kind;
  return kind === "payment" || kind === "courier" || kind === "sms" || kind === "fraud" ? kind : "other";
}

/** Features by group, in group order; recommended ones first within a group. */
export function groupedFeatures(features: readonly AppFeature[]): Array<{ group: FeatureGroup; features: AppFeature[] }> {
  return FEATURE_GROUPS
    .map((group) => ({
      group,
      features: features
        .filter((feature) => featureGroup(feature) === group)
        .sort((left, right) => Number(right.recommended) - Number(left.recommended)),
    }))
    .filter((entry) => entry.features.length > 0);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h4 className="text-caption font-medium text-muted-foreground">{title}</h4>
      <ul className="space-y-1">{children}</ul>
    </section>
  );
}

/** What one feature asks for, in plain words: only its own part, never the app's base. */
export function FeatureAccess({ feature }: { feature: AppFeature }) {
  const t = useMessages(appFeaturesMessages);
  const apps = useMessages(installedAppsMessages);
  const scopeText = useMessages(appScopeMessages);
  const { request } = feature;
  const sections: ReactNode[] = [];
  if (request.scopes.length > 0) {
    sections.push(
      <Section key="data" title={t("access_data")}>
        {request.scopes.map((scope) => (
          <li key={scope.name} className="flex items-start justify-between gap-3 text-body">
            <span className="min-w-0 space-y-0.5">
              <span className="block">{scopeText(`scope_${scope.name}`)}</span>
              <span className="block text-caption text-muted-foreground">{scopeText(`scope_${scope.name}_help`)}</span>
            </span>
            <span className="flex shrink-0 flex-wrap justify-end gap-1">
              {scope.sensitive ? <Badge variant="attention">{apps("sensitive")}</Badge> : null}
              <Badge variant={RISK_VARIANT[scope.risk]}>{apps(`risk_${scope.risk}`)}</Badge>
            </span>
          </li>
        ))}
      </Section>,
    );
  }
  const does = [
    ...request.providers.map((provider) => ({ key: provider.id, text: apps(`provider_${provider.kind}`) })),
    ...(request.publicRoutes ? [{ key: "public", text: t("access_publicRoutes") }] : []),
    ...(request.cron.length > 0 ? [{ key: "cron", text: t("access_jobs") }] : []),
    ...(request.admin ? [{ key: "admin", text: t("access_admin") }] : []),
    ...(request.storefront ? [{ key: "storefront", text: t("access_storefront") }] : []),
  ];
  const uniqueDoes = does.filter((entry, index) => does.findIndex((other) => other.text === entry.text) === index);
  if (uniqueDoes.length > 0) {
    sections.push(
      <Section key="does" title={t("access_services")}>
        {uniqueDoes.map((entry) => <li key={entry.key} className="text-body">{entry.text}</li>)}
      </Section>,
    );
  }
  if (request.events.length > 0) {
    sections.push(
      <Section key="events" title={t("access_events")}>
        {request.events.map((topic) => <li key={topic} className="text-body">{topicLabel(topic)}</li>)}
      </Section>,
    );
  }
  if (request.functions.length > 0) {
    sections.push(
      <Section key="checkout" title={t("access_checkout")}>
        {request.functions.map((point) => <li key={point} className="font-mono text-body">{point}</li>)}
      </Section>,
    );
  }
  if (request.allowedHosts.length > 0) {
    sections.push(
      <Section key="hosts" title={t("access_hosts")}>
        {request.allowedHosts.map((host) => <li key={host} dir="ltr" translate="no" className="break-all font-mono text-body">{host}</li>)}
      </Section>,
    );
  }
  if (sections.length === 0) return <p className="text-body text-muted-foreground">{t("noExtraAccess")}</p>;
  return <div className="space-y-3">{sections}</div>;
}

interface FeatureDialogProps {
  app: AppDetail;
  feature: AppFeature;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** A Super Admin's consent to one feature's access. */
function EnableFeatureDialog({ app, feature, open, onOpenChange }: FeatureDialogProps) {
  const t = useMessages(appFeaturesMessages);
  const result = useAppMutationResult(app);
  const enable = useMutation({
    mutationFn: () => enableAppFeature(app, feature),
    onSuccess: ({ app: next, hookError }) => {
      result.applied(next, hookError, t("enabled", { name: feature.name }));
      if (feature.request.providers.length > 0) toast.info(t("setUpNext"));
      onOpenChange(false);
    },
    onError: (error) => {
      if (result.changed(error)) return;
      toast.error(t("enableFailed", { name: feature.name }));
    },
  });
  return (
    <Dialog open={open} onOpenChange={(next) => (enable.isPending ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("enableTitle", { name: feature.name })}</DialogTitle>
          <DialogDescription>{t("enableIntro", { app: app.name, name: feature.name })}</DialogDescription>
        </DialogHeader>
        <FeatureAccess feature={feature} />
        <p className="text-body">{t("enableConsent", { app: app.name, name: feature.name })}</p>
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

function DisableFeatureDialog({ app, feature, open, onOpenChange }: FeatureDialogProps) {
  const t = useMessages(appFeaturesMessages);
  const result = useAppMutationResult(app);
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
          <AlertDialogDescription>{t("disableBody", { app: app.name, name: feature.name })}</AlertDialogDescription>
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

function FeatureRow({ feature, canTurnOn, canTurnOff, onToggle }: {
  feature: AppFeature;
  canTurnOn: boolean;
  canTurnOff: boolean;
  onToggle: () => void;
}) {
  const t = useMessages(appFeaturesMessages);
  const enabled = feature.enabled;
  const allowed = enabled ? canTurnOff : canTurnOn;
  const describedBy = `app-feature-${feature.id}-description`;
  return (
    <li className="flex items-start justify-between gap-4 border-t border-border px-4 py-3 first:border-t-0">
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body font-medium">{feature.name}</span>
          {feature.recommended && !enabled ? <Badge variant="info">{t("recommended")}</Badge> : null}
          <Badge variant={enabled ? "success" : "secondary"}>{t(enabled ? "on" : "off")}</Badge>
        </div>
        <p id={describedBy} className="text-caption text-muted-foreground">{feature.description}</p>
      </div>
      <Switch
        checked={enabled}
        disabled={!allowed}
        onCheckedChange={onToggle}
        aria-label={t("toggleLabel", { name: feature.name })}
        aria-describedby={describedBy}
      />
    </li>
  );
}

/**
 * The features card on the app page. `canManage`: may turn features off;
 * `isSuperAdmin`: may also turn them on (consent). Turning on needs the app
 * to be active.
 */
export function AppFeatures({ app, canManage, isSuperAdmin }: { app: AppDetail; canManage: boolean; isSuperAdmin: boolean }) {
  const t = useMessages(appFeaturesMessages);
  const [dialog, setDialog] = useState<{ feature: AppFeature; turn: "on" | "off" } | null>(null);
  if (app.features.length === 0) return null;
  const active = app.status === "active";
  const canTurnOn = active && isSuperAdmin && app.runtimeAvailable;
  const note = !active ? t("activateFirst") : canManage && !isSuperAdmin ? t("superAdminTurnsOn") : null;
  const close = (open: boolean) => {
    if (!open) setDialog(null);
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      {note ? <CardContent><p role="status" className="rounded-lg bg-muted px-4 py-2 text-body text-muted-foreground">{note}</p></CardContent> : null}
      {groupedFeatures(app.features).map(({ group, features }) => (
        <section key={group} aria-labelledby={`app-features-${group}`} className="border-t border-border">
          <h3 id={`app-features-${group}`} className="px-4 pt-3 text-caption font-medium text-muted-foreground">{t(`group_${group}`)}</h3>
          <ul>
            {features.map((feature) => (
              <FeatureRow
                key={feature.id}
                feature={feature}
                canTurnOn={canTurnOn}
                canTurnOff={canManage}
                onToggle={() => setDialog({ feature, turn: feature.enabled ? "off" : "on" })}
              />
            ))}
          </ul>
        </section>
      ))}
      {dialog?.turn === "on" ? <EnableFeatureDialog app={app} feature={dialog.feature} open onOpenChange={close} /> : null}
      {dialog?.turn === "off" ? <DisableFeatureDialog app={app} feature={dialog.feature} open onOpenChange={close} /> : null}
    </Card>
  );
}

/** The Permissions tab's part: what every feature could reach, on or off. */
export function AppFeatureAccess({ app }: { app: AppDetail }) {
  const t = useMessages(appFeaturesMessages);
  if (app.features.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("permissionsTitle")}</CardTitle>
        <CardDescription>{t("permissionsDescription")}</CardDescription>
      </CardHeader>
      <ul className="border-t border-border">
        {app.features.map((feature) => (
          <li key={feature.id} className="space-y-2 border-t border-border px-4 py-3 first:border-t-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-body font-medium">{feature.name}</span>
              <Badge variant={feature.enabled ? "success" : "secondary"}>{t(feature.enabled ? "on" : "off")}</Badge>
            </div>
            <FeatureAccess feature={feature} />
          </li>
        ))}
      </ul>
    </Card>
  );
}
