// The app page's Settings tab: only the app-wide settings, in the sections
// the app declares (one card each, Polaris), saved with the page save bar.
// The fields of each service the app offers are not here: each service is a
// collapsed group with its Configured / Not set status, opening its setup
// sheet or the settings page where it is used. Secret values never reach the
// page: a field reads only "Set" or "Not set".
import { Link } from "@tanstack/react-router";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "~/components/ui/accordion";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { useMessages } from "~/i18n";
import { installedAppsMessages } from "~/i18n/apps";
import { appSurfacesMessages } from "~/i18n/app-surfaces";
import { appProvidersMessages } from "~/i18n/settings-app-providers";
import { settingsNavMessages } from "~/i18n/settings";
import type { AppDetail } from "~/lib/api-query-options/apps";
import { PROVIDER_CAPABILITY, isAppProviderKind, providerHash } from "./app-capabilities";
import { AppIcon } from "./AppIcon";
import { useOpenAppProvider } from "./AppProviderSheetHost";
import { AppSettingControl, providerConfigured, settingIsSet, useAppSettingsDraft } from "./AppSettingsForm";

type Provider = AppDetail["providers"][number];

/** One service the app offers, collapsed: its status, its fields' Set / Not set, and where it is set up. */
function ProviderGroup({ app, provider }: { app: AppDetail; provider: Provider }) {
  const t = useMessages(appSurfacesMessages);
  const p = useMessages(appProvidersMessages);
  const settingsPage = useMessages(settingsNavMessages);
  const openProvider = useOpenAppProvider();
  const configured = providerConfigured(app, provider);
  const fields = app.settings.fields.filter((field) => provider.settings.includes(field.key));
  const capability = isAppProviderKind(provider.kind) ? PROVIDER_CAPABILITY[provider.kind] : null;
  return (
    <AccordionItem value={provider.id}>
      <AccordionTrigger>
        <span className="flex min-w-0 flex-1 items-center gap-3">
          <AppIcon src={provider.icon} size="sm" />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{provider.name}</span>
            <span className="block truncate font-normal text-muted-foreground">
              {isAppProviderKind(provider.kind) ? t(`kind_${provider.kind}`) : provider.kind}
              {" · "}
              {fields.length === 1 ? t("providerFieldsOne") : t("providerFields", { count: String(fields.length) })}
            </span>
          </span>
          <Badge variant={configured ? "success" : "secondary"}>{p(configured ? "configured" : "notSet")}</Badge>
        </span>
      </AccordionTrigger>
      <AccordionContent>
        <div className="space-y-3">
          <ul className="space-y-1">
            {fields.map((field) => {
              const set = settingIsSet(app, field.key);
              return (
                <li key={field.key} className="flex items-center justify-between gap-3 text-body">
                  <span className="min-w-0 truncate">{field.label}</span>
                  <span className={set ? "shrink-0 text-foreground" : "shrink-0 text-muted-foreground"}>{t(set ? "fieldSet" : "fieldNotSet")}</span>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            {openProvider ? (
              <Button type="button" variant={configured ? "outline" : "default"} size="sm" onClick={() => openProvider(provider.id)}>
                {p(configured ? "editSettings" : "setUp", { name: provider.name })}
              </Button>
            ) : null}
            {capability ? (
              <Button asChild variant="link" size="sm">
                <Link to={capability.to} hash={providerHash(provider.id)}>{t("providerSetIn", { page: settingsPage(capability.page) })}</Link>
              </Button>
            ) : null}
          </div>
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}

export function AppSettingsTab({ app, canManage }: { app: AppDetail; canManage: boolean }) {
  const t = useMessages(appSurfacesMessages);
  const apps = useMessages(installedAppsMessages);
  const { sections } = app.settings;
  const keys = sections.flatMap((section) => section.keys);
  const form = useAppSettingsDraft(app, { canManage, keys });
  const fieldsOf = (sectionKeys: readonly string[]) => app.settings.fields.filter((field) => sectionKeys.includes(field.key));
  // Required settings activation still needs; a service's own fields wait in its group.
  const missing = app.status !== "active" ? app.settings.fields.filter((field) => app.settings.missing.includes(field.key)) : [];
  const groups = app.providers.filter((provider) => provider.own);
  return (
    <div className="space-y-4">
      {missing.length > 0 ? (
        <Alert variant="warning">
          <AlertDescription>{apps("missingBody", { settings: missing.map((field) => field.label).join(", ") })}</AlertDescription>
        </Alert>
      ) : null}
      {sections.map((section) => (
        <Card key={section.group?.id ?? "general"}>
          <CardHeader>
            <CardTitle>{section.group?.title ?? (sections.length > 1 ? t("generalSettings") : apps("settingsTitle"))}</CardTitle>
            {section.group?.description ? <CardDescription>{section.group.description}</CardDescription> : null}
          </CardHeader>
          <CardContent className="space-y-4">
            {fieldsOf(section.keys).map((field) => (
              <AppSettingControl key={field.key} app={app} field={field} form={form} canManage={canManage} />
            ))}
          </CardContent>
        </Card>
      ))}
      {sections.length === 0 && groups.length === 0 ? (
        <Card>
          <CardContent className="py-4">
            <p className="text-body text-muted-foreground">{t("noAppSettings")}</p>
          </CardContent>
        </Card>
      ) : null}
      {groups.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("providersTitle")}</CardTitle>
            <CardDescription>{t("providersDescription")}</CardDescription>
          </CardHeader>
          <div className="border-t border-border px-4">
            <Accordion type="multiple">
              {groups.map((provider) => <ProviderGroup key={provider.id} app={app} provider={provider} />)}
            </Accordion>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
