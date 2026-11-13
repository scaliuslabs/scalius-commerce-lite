import { useMemo } from "react";
import { richTextExceedsSearchText, SEARCH_TEXT_MAX_LENGTH } from "@scalius/shared/search-text";
import { useMessages } from "~/i18n";
import { searchTextMessages } from "~/i18n/search-text";

/**
 * The help line of a rich-text field whose text runs past what search reads
 * (`SEARCH_TEXT_MAX_LENGTH` characters of plain text), or undefined.
 */
export function useSearchTextLimitHelp(html: string | null | undefined): string | undefined {
  const t = useMessages(searchTextMessages);
  const exceeds = useMemo(() => richTextExceedsSearchText(html), [html]);
  return exceeds ? t("searchReadsStart", { count: SEARCH_TEXT_MAX_LENGTH }) : undefined;
}
