// One feature's page in an app (Stripe's payment method page, Shopify's
// provider page): a header card with its name, what it does, its status and
// its own on/off switch, then its setup while it is on (the fields save with
// the page's save bar) and what it can reach. The switch never waits for
// Save: turning a feature on is a Super Admin's consent to its access alone,
// turning it off says what stops, and both apply when confirmed.
import { useEffect, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Switch } from "~/components/ui/switch";
import { useMessages } from "~/i18n";
import { appFeaturesMessages } from "~/i18n/app-features";
import type { AppDetail, AppFeature } from "~/lib/api-query-options/apps";
import { itemSettingKeys, type ServiceHealth, type ServiceItem } from "./app-services";
import { DisableFeatureDialog, EnableFeatureDialog, FeatureAccess, HealthBadge, RunningDetail, useAccessLine } from "./AppFeatures";
import { AppIcon } from "./AppIcon";
import { settingFieldId, useAppSettingsDraft } from "./AppSettingsForm";

export function AppFeatureSection({ app, feature, health, canManage, isSuperAdmin }: {
  app: AppDetail;
  feature: AppFeature;
  health: ServiceHealth;
  canManage: boolean;
  isSuperAdmin: boolean;
}) {
  const t = useMessages(appFeaturesMessages);
  const access = useAccessLine(feature);
  const item: ServiceItem = { kind: "feature", id: `feature:${feature.id}`, feature };
  const keys = itemSettingKeys(app, item);
  // Only this feature's fields are this page's draft; the rest of the app's settings are sent as saved.
  const form = useAppSettingsDraft(app, { canManage, keys, label: feature.name });
  const [turn, setTurn] = useState<"on" | "off" | null>(null);
  const [focusFirst, setFocusFirst] = useState(false);
  const active = app.status === "active";
  const canTurnOn = active && isSuperAdmin && app.runtimeAvailable;
  const note = !active ? t("activateFirst") : canManage && !isSuperAdmin && !feature.enabled ? t("superAdminTurnsOn") : null;
  const switchId = `feature-switch-${feature.id}`;
  const icon = feature.request.providers[0]?.icon ?? app.icon;
  // Just turned on: its first setting takes the cursor.
  useEffect(() => {
    if (focusFirst && feature.enabled && keys[0]) document.getElementById(settingFieldId(keys[0]))?.focus();
  }, [focusFirst, feature.enabled, keys]);
  const close = (open: boolean) => {
    if (!open) setTurn(null);
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-col gap-3 pt-4">
          <div className="flex items-start gap-3">
            <AppIcon src={icon} size="md" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h2 className="text-heading-sm">{feature.name}</h2>
                <Badge variant={feature.enabled ? "success" : "secondary"}>{t(feature.enabled ? "on" : "off")}</Badge>
                {feature.recommended && !feature.enabled ? <Badge variant="info">{t("recommended")}</Badge> : null}
                <HealthBadge health={health} />
              </div>
              <p id={`${switchId}-help`} className="text-body text-muted-foreground">{feature.description}</p>
            </div>
          </div>
          <div className="flex items-start justify-between gap-3 border-t border-border pt-3">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <label htmlFor={switchId} className="text-body font-medium">{t(feature.enabled ? "switchOn" : "switchOff", { name: feature.name })}</label>
              <span className="text-body text-muted-foreground">{note ?? t("appliesNow")}</span>
            </div>
            <Switch
              id={switchId}
              checked={feature.enabled}
              disabled={feature.enabled ? !canManage : !canTurnOn}
              aria-describedby={`${switchId}-help`}
              onCheckedChange={() => setTurn(feature.enabled ? "off" : "on")}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("setupTitle")}</CardTitle>
          {feature.enabled ? null : <CardDescription>{t("setupWhenOn", { name: feature.name })}</CardDescription>}
        </CardHeader>
        {feature.enabled ? (
          <CardContent>
            <RunningDetail app={app} item={item} form={form} canManage={canManage} health={health} inRow={false} />
          </CardContent>
        ) : null}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("accessTitle")}</CardTitle>
          <CardDescription>{access}</CardDescription>
        </CardHeader>
        <CardContent>
          <FeatureAccess feature={feature} />
        </CardContent>
      </Card>

      <EnableFeatureDialog app={app} feature={feature} open={turn === "on"} onOpenChange={close} onEnabled={() => setFocusFirst(true)} />
      <DisableFeatureDialog app={app} feature={feature} open={turn === "off"} onOpenChange={close} />
    </div>
  );
}
