// A resource page's Translations card (docs/MARKETS-DESIGN.md D9): one tab
// per other store language, each with the side-by-side editor of this
// product, collection or category in that language. A store with only its
// default language shows nothing. Loaded after the page (LazyResourceTranslationsCard).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { usePermissions } from "~/contexts/PermissionContext";
import { useLocale, useMessages } from "~/i18n";
import { translationsMessages } from "~/i18n/translations";
import { storeLanguagesQueryOptions, type TranslationEditorType } from "~/lib/api-query-options/translations";
import { DeferredTiptapEditor } from "~/components/ui/tiptap/DeferredTiptapEditor";
import { TranslationEditor } from "./TranslationEditor";
import { languageName } from "./translation-form";
import { canEditTranslations } from "./translation-permissions";

export function ResourceTranslationsCard({ type, id }: { type: TranslationEditorType; id: string }) {
  const t = useMessages(translationsMessages);
  const uiLocale = useLocale();
  const permissions = usePermissions();
  const languages = useQuery(storeLanguagesQueryOptions());
  const targets = (languages.data ?? []).filter((language) => !language.isDefault);
  const [locale, setLocale] = useState<string | null>(null);
  if (targets.length === 0) return null;
  const active = targets.some((language) => language.locale === locale) ? locale! : targets[0]!.locale;
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle>{t("translationsCard")}</CardTitle>
          <p className="text-body text-muted-foreground">{t("translationsCardHelp")}</p>
        </div>
        <Link to="/admin/translations" search={{ type, id, locale: active }} className="text-body text-link hover:underline">
          {t("openInTranslate")}
        </Link>
      </CardHeader>
      <CardContent>
        <Tabs value={active} onValueChange={setLocale}>
          <TabsList className="flex h-auto flex-wrap justify-start">
            {targets.map((language) => (
              <TabsTrigger key={language.locale} value={language.locale}>{languageName(language.locale, uiLocale)}</TabsTrigger>
            ))}
          </TabsList>
          {targets.map((language) => (
            <TabsContent key={language.locale} value={language.locale} className="pt-4">
              {language.locale === active ? (
                <TranslationEditor
                  type={type}
                  id={id}
                  locale={language.locale}
                  marketId={null}
                  canEdit={canEditTranslations(permissions.hasPermission, type)}
                  embedded
                  richTextEditor={DeferredTiptapEditor}
                />
              ) : null}
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
}
