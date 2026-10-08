// A product, collection or category page's "Translate" action (Shopify's
// pattern): an item in its "More actions" menu that opens Translate & adapt on
// this resource. Offered once the store has a second language. The dashboard's
// own probe (lib/store-reach-probe.tsx) already reads the store's languages
// into the query cache, so this page asks the API nothing and downloads no
// translation code; translate & adapt picks the store's first other language.
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { DropdownMenuItem } from "~/components/ui/dropdown-menu";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";
import { STORE_LANGUAGES_QUERY_KEY, type TranslationEditorType } from "~/lib/translation-types";

/** The menu item, or null while the store has only its default language (or the item is new). */
export function useTranslateMenuItem(type: TranslationEditorType, id: string | undefined): ReactNode {
  const r = useMessages(resourceMessages);
  const { data: hasSecondLanguage } = useQuery({
    queryKey: STORE_LANGUAGES_QUERY_KEY,
    // Never fetches here: the probe fills this key.
    enabled: false,
    select: (languages: readonly unknown[]) => languages.length > 1,
  });
  if (!id || !hasSecondLanguage) return null;
  return (
    <DropdownMenuItem key="translate" asChild>
      <Link to="/admin/translations" search={{ type, id }}>{r("translate")}</Link>
    </DropdownMenuItem>
  );
}
