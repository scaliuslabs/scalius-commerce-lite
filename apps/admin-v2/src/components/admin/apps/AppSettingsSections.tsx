// The app's own settings on its page: the fields no feature or provider owns,
// in the sections the app declares (one card each, Polaris), saved with the
// page's save bar. A service's fields sit with its row instead. Secret
// values never reach the page: a field reads only "Set" or "Not set".
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { FieldGroup } from "~/components/ui/field";
import { useMessages } from "~/i18n";
import { installedAppsMessages } from "~/i18n/apps";
import { appSurfacesMessages } from "~/i18n/app-surfaces";
import type { AppDetail } from "~/lib/api-query-options/apps";
import { serviceSettingKeys } from "./app-services";
import { AppSettingControl, type AppSettingsDraftApi } from "./AppSettingsForm";

export function AppSettingsSections({ app, form, canManage }: { app: AppDetail; form: AppSettingsDraftApi; canManage: boolean }) {
  const t = useMessages(appSurfacesMessages);
  const apps = useMessages(installedAppsMessages);
  const owned = serviceSettingKeys(app);
  const sections = app.settings.sections
    .map((section) => ({ ...section, fields: app.settings.fields.filter((field) => section.keys.includes(field.key) && !owned.has(field.key)) }))
    .filter((section) => section.fields.length > 0);
  return sections.map((section) => (
    <Card key={section.group?.id ?? "general"}>
      <CardHeader>
        <CardTitle>{section.group?.title ?? (sections.length > 1 ? t("generalSettings") : apps("settingsTitle"))}</CardTitle>
        {section.group?.description ? <CardDescription>{section.group.description}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        <FieldGroup>
          {section.fields.map((field) => <AppSettingControl key={field.key} app={app} field={field} form={form} canManage={canManage} />)}
        </FieldGroup>
      </CardContent>
    </Card>
  ));
}
