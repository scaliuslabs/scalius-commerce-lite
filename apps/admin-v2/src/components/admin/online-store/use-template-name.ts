import { useMemo } from "react";
import { STOREFRONT_TEMPLATE_IDS } from "@scalius/shared/storefront-theme";
import { useMessages } from "~/i18n";
import { onlineStoreCommonMessages } from "~/i18n/online-store-common";
import { themeEditorMessages } from "~/i18n/theme-editor";
import type { ThemeApp } from "~/lib/api-query-options/online-store";
import { appTemplates } from "./theme-settings";

type MessageKey = keyof (typeof onlineStoreCommonMessages)["en"];

/** A template's name from its key: a built-in template's in the dashboard's language, an app's as the app names it. */
export function useTemplateName(apps: readonly ThemeApp[]): (key: string) => string {
  const t = useMessages(onlineStoreCommonMessages);
  const editor = useMessages(themeEditorMessages);
  const offered = useMemo(() => appTemplates(apps), [apps]);
  return (key) => {
    if ((STOREFRONT_TEMPLATE_IDS as readonly string[]).includes(key)) return t(`template_${key}` as MessageKey);
    // An app's template no longer offered has no name here: it reads as an app's template, never as its key.
    return offered.find((template) => template.key === key)?.name ?? editor("templateUnknown");
  };
}
