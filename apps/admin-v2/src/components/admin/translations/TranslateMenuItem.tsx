// A product, collection or category page's "Translate" action (Shopify's
// pattern): an item in its "More actions" menu that opens Translate & adapt on
// this resource. Offered only when the store has a second language.
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { DropdownMenuItem } from "~/components/ui/dropdown-menu";
import { useMessages } from "~/i18n";
import { translationsMessages } from "~/i18n/translations";
import { storeLanguagesQueryOptions, type TranslationEditorType } from "~/lib/api-query-options/translations";

/** The menu item, or null while the store has only its default language. */
export function useTranslateMenuItem(type: TranslationEditorType, id: string | undefined): ReactNode {
  const t = useMessages(translationsMessages);
  const languages = useQuery({ ...storeLanguagesQueryOptions(), enabled: id !== undefined });
  const target = (languages.data ?? []).find((language) => !language.isDefault);
  if (!id || !target) return null;
  return (
    <DropdownMenuItem key="translate" asChild>
      <Link to="/admin/translations" search={{ type, id, locale: target.locale }}>{t("translateItem")}</Link>
    </DropdownMenuItem>
  );
}
