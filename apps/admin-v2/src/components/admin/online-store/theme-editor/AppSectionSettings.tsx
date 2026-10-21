/**
 * An app section's settings in the theme editor: the form drawn from the
 * fields its app declares, or, while the app is not active, why the store
 * does not show it (the section keeps its values for when the app is back).
 */
import type { StorefrontAppSection } from "@scalius/shared/storefront-theme";
import { useMessages } from "~/i18n";
import { themeEditorFull } from "~/i18n/theme-editor-panes";
import { sectionFieldPrefix } from "../SectionSettings";
import { themeAppFields, type AppSettingValues } from "../schema-form/app-settings";
import { AppSettingFields } from "../schema-form/AppSettingFields";
import type { MediaPreviews } from "../schema-form/media-previews";
import type { AppSectionEntry } from "./editor-state";

/** The field ids of an app section's settings start with this (`theme-section-app-2-values`). */
export const appSectionFieldPrefix = (sectionId: string) => `${sectionFieldPrefix(sectionId)}-values`;

/**
 * A rejected save's issues (by data path under the section's `settings`) as
 * messages by setting key, plus the first one no field shows.
 */
function issuesByKey(issues: ReadonlyMap<string, string> | undefined): { fields: Map<string, string>; other: string | null } {
  const fields = new Map<string, string>();
  let other: string | null = null;
  for (const [path, message] of issues ?? []) {
    const key = /^values\.([^.]+)/.exec(path)?.[1];
    if (key) {
      if (!fields.has(key)) fields.set(key, message);
    } else {
      other ??= message;
    }
  }
  return { fields, other };
}

export function AppSectionSettings({ section, entry, issues, media, onChange }: {
  section: StorefrontAppSection;
  /** The app's section as the workspace offers it; absent while the app is not active. */
  entry: AppSectionEntry | undefined;
  issues?: ReadonlyMap<string, string>;
  media: MediaPreviews;
  onChange: (values: AppSettingValues) => void;
}) {
  const t = useMessages(themeEditorFull);
  if (!entry) return <p role="status" className="text-body text-muted-foreground">{t("appInactiveHelp")}</p>;
  const { fields, other } = issuesByKey(issues);
  const description = entry.section.description;
  return (
    <div className="space-y-4">
      <p className="text-body text-muted-foreground">
        {description ? `${description} ` : null}
        {t("appFrom", { app: entry.app.name })}
      </p>
      {other ? <p role="alert" className="text-body text-destructive">{other}</p> : null}
      {themeAppFields(entry.section.settings).length > 0 ? (
        <AppSettingFields
          idPrefix={appSectionFieldPrefix(section.id)}
          fields={entry.section.settings}
          values={section.settings.values}
          errors={fields}
          media={media}
          onChange={onChange}
        />
      ) : (
        <p className="text-body text-muted-foreground">{t("appNoSettings")}</p>
      )}
    </div>
  );
}
