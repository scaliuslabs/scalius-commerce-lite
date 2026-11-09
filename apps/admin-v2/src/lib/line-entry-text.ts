// An order line's entries as staff read them: the platform's own words
// ("Yes", "Add-on", "2 files") in the dashboard's language, from the same
// catalogue the storefront writes them from (`@scalius/shared/line-entry-words`);
// the merchant's labels, the buyer's text and apps' words stay as frozen.
import { useCallback } from "react";
import { lineEntryWords, presentLineEntry, type LineEntryText } from "@scalius/shared/line-entry-words";
import { formatNumber, useLocale } from "~/i18n";

export function useLineEntryText() {
  const locale = useLocale();
  return useCallback(<T extends LineEntryText>(entry: T): T => presentLineEntry(entry, lineEntryWords(locale), (value) => formatNumber(value)), [locale]);
}
