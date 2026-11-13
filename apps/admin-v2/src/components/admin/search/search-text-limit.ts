import { useMemo } from "react";
import { searchTextCoverage } from "@scalius/shared/search-text";
import { useMessages } from "~/i18n";
import { searchTextMessages } from "~/i18n/search-text";

/**
 * The help line of a rich-text field whose text runs past what search reads
 * (`searchTextCoverage`: the characters of plain text it reads), or undefined.
 */
export function useSearchTextLimitHelp(html: string | null | undefined): string | undefined {
  const t = useMessages(searchTextMessages);
  const coverage = useMemo(() => searchTextCoverage(html), [html]);
  return coverage === null ? undefined : t("searchReadsStart", { count: coverage });
}
