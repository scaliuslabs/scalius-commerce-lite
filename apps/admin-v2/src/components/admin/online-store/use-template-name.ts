import { STOREFRONT_TEMPLATE_IDS } from "@scalius/shared/storefront-theme";
import { useMessages } from "~/i18n";
import { onlineStoreCommonMessages } from "~/i18n/online-store-common";
import { themeEditorMessages } from "~/i18n/theme-editor";
import type { ThemeApp } from "~/lib/api-query-options/online-store";

type MessageKey = keyof (typeof onlineStoreCommonMessages)["en"];

/** A template's name from its key: a built-in template's in the dashboard's language, an app's as the app names it. */
export function useTemplateName(apps: readonly ThemeApp[]): (key: string) => string {
  const t = useMessages(onlineStoreCommonMessages);
  const editor = useMessages(themeEditorMessages);
  return (key) => {
    if ((STOREFRONT_TEMPLATE_IDS as readonly string[]).includes(key)) return t(`template_${key}` as MessageKey);
    // An app's template the API no longer lists has no name here: it reads as an app's template, never as its key.
    for (const app of apps) {
      const template = app.templates.find((each) => each.key === key);
      if (template) return template.name;
    }
    return editor("templateUnknown");
  };
}
