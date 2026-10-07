// Translate & adapt (docs/MARKETS-DESIGN.md D9), Shopify's: pick the language
// (and, to adapt, one market), the kind of resource, then an item; its
// fields open beside the list on a computer and in place of it on a phone.
// The editor downloads when the first item opens. The page's state lives in
// its URL, so a link (Settings › Languages, a product's Translations card)
// opens the same item.
import { lazy, Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Languages } from "lucide-react";
import { EmptyState } from "~/components/admin/resource/EmptyState";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Skeleton } from "~/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { usePermissions } from "~/contexts/PermissionContext";
import { useLocale, useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";
import { translationsMessages } from "~/i18n/translations";
import { marketsQueryOptions } from "~/lib/api-query-options/markets";
import {
  TRANSLATION_EDITOR_TYPES,
  storeLanguagesQueryOptions,
  translationResourcesQueryOptions,
  type TranslationEditorType,
} from "~/lib/api-query-options/translations";
import { isTranslationEditorType, type TranslationsSearch } from "~/lib/translation-types";
import { cn } from "@scalius/shared/utils";
import { STATUS_BADGE, TYPE_LABEL_KEYS, languageName } from "./translation-form";
import { canEditTranslations } from "./translation-permissions";

// The editor downloads when the first item opens. It edits HTML fields as
// HTML here: the rich text editor stays with the resource pages that load it.
const TranslationEditor = lazy(() => import("./TranslationEditor").then((module) => ({ default: module.TranslationEditor })));

const text = (value: unknown, max: number) => typeof value === "string" && value && value.length <= max ? value : undefined;

/** The URL's search, checked: anything unknown or malformed is left out. */
export function parseTranslationsSearch(search: Record<string, unknown>): TranslationsSearch {
  const page = Number(search.page);
  return {
    ...(isTranslationEditorType(search.type) ? { type: search.type } : {}),
    ...(typeof search.locale === "string" && /^[a-z]{2}$/.test(search.locale) ? { locale: search.locale } : {}),
    ...(text(search.market, 64) ? { market: text(search.market, 64) } : {}),
    ...(text(search.id, 128) ? { id: text(search.id, 128) } : {}),
    ...(text(search.q, 120) ? { q: text(search.q, 120) } : {}),
    ...(Number.isInteger(page) && page > 1 && page <= 10_000 ? { page } : {}),
  };
}

export function TranslationsWorkspace({ search: rawSearch }: { search: Record<string, unknown> }) {
  const search = parseTranslationsSearch(rawSearch);
  const t = useMessages(translationsMessages);
  const r = useMessages(resourceMessages);
  const uiLocale = useLocale();
  const navigate = useNavigate();
  const permissions = usePermissions();
  const languages = useQuery(storeLanguagesQueryOptions());
  const markets = useQuery(marketsQueryOptions());
  const targets = (languages.data ?? []).filter((language) => !language.isDefault);
  const type = search.type ?? "product";
  const locale = targets.some((language) => language.locale === search.locale) ? search.locale! : targets[0]?.locale ?? "";
  const marketId = search.market ?? null;
  const page = search.page ?? 1;
  const [query, setQuery] = useState(search.q ?? "");
  const resources = useQuery({
    ...translationResourcesQueryOptions({ type, locale, marketId, search: search.q ?? "", page }),
    enabled: locale !== "",
  });
  const update = (next: Partial<TranslationsSearch>) => {
    const merged: TranslationsSearch = { ...search, ...next };
    const cleaned = Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined && value !== "" && value !== null)) as TranslationsSearch;
    void navigate({ to: "/admin/translations", search: cleaned, replace: true });
  };

  const header = <PageHeader title={t("translateTitle")} />;
  if (languages.isError) {
    return (
      <div className="pb-8">
        {header}
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-body">{t("translateLoadFailed")}</p>
          <Button variant="outline" size="sm" onClick={() => void languages.refetch()}>{r("retry")}</Button>
        </Card>
      </div>
    );
  }
  if (languages.isPending) {
    return (
      <div className="pb-8">
        {header}
        <Card className="space-y-3 p-4">{[0, 1, 2].map((index) => <Skeleton key={index} className="h-10 w-full" />)}</Card>
      </div>
    );
  }
  if (targets.length === 0) {
    return (
      <div className="pb-8">
        {header}
        <Card>
          <EmptyState
            icon={Languages}
            title={t("noLanguages")}
            description={t("noLanguagesHelp")}
            action={<Button asChild><Link to="/admin/settings/languages">{t("openLanguages")}</Link></Button>}
          />
        </Card>
      </div>
    );
  }

  const languageOptions = targets.map((language) => ({
    value: language.locale,
    label: languageName(language.locale, uiLocale),
    description: language.published ? t("published") : t("unpublished"),
  }));
  const marketOptions = [
    { value: "", label: t("allMarkets") },
    ...(markets.data ?? []).filter((market) => !market.isBackup).map((market) => ({ value: market.id, label: market.name })),
  ];
  const items = resources.data?.items ?? [];
  const pages = Math.max(1, Math.ceil((resources.data?.total ?? 0) / (resources.data?.limit ?? 25)));
  const selected = search.id ?? null;

  return (
    <div className="pb-8">
      {header}
      <p className="mb-4 max-w-3xl text-body text-muted-foreground">{t("translateDescription")}</p>
      <Card className="mb-4 grid gap-3 p-4 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1">
          <Label>{t("targetLanguage")}</Label>
          <SearchableSelect
            ariaLabel={t("targetLanguage")}
            value={locale}
            options={languageOptions}
            onValueChange={(value) => update({ locale: value, page: undefined })}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <Label>{t("market")}</Label>
          <SearchableSelect
            ariaLabel={t("market")}
            value={marketId ?? ""}
            options={marketOptions}
            onValueChange={(value) => update({ market: value || undefined, page: undefined })}
          />
          <p className="text-body text-muted-foreground">{t("marketHelp")}</p>
        </div>
      </Card>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card className={cn("overflow-clip", selected && "max-lg:hidden")}>
          <div className="border-b p-3">
            <Tabs value={type} onValueChange={(value) => update({ type: value as TranslationEditorType, id: undefined, page: undefined, q: undefined })}>
              <TabsList className="flex h-auto flex-wrap justify-start">
                {TRANSLATION_EDITOR_TYPES.map((each) => (
                  <TabsTrigger key={each} value={each}>{t(TYPE_LABEL_KEYS[each] as "typeProduct")}</TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <form
              className="mt-3"
              onSubmit={(event) => {
                event.preventDefault();
                update({ q: query.trim() || undefined, page: undefined });
              }}
            >
              <Label htmlFor="translation-search" className="sr-only">{t("search")}</Label>
              <Input
                id="translation-search"
                type="search"
                placeholder={t("search")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onBlur={() => update({ q: query.trim() || undefined, page: undefined })}
              />
            </form>
          </div>
          {resources.isPending ? (
            <div className="space-y-2 p-3">{[0, 1, 2, 3].map((index) => <Skeleton key={index} className="h-10 w-full" />)}</div>
          ) : items.length === 0 ? (
            <p className="p-4 text-body text-muted-foreground">{search.q ? t("noResourcesSearch") : t("noResources")}</p>
          ) : (
            <ul className="divide-y">
              {items.map((item) => {
                const status = STATUS_BADGE[item.status];
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      aria-current={item.id === selected ? "true" : undefined}
                      className={cn(
                        "flex min-h-12 w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent",
                        item.id === selected && "bg-accent",
                      )}
                      onClick={() => update({ id: item.id })}
                    >
                      <span className="min-w-0 flex-1 truncate text-body" title={item.title}>{item.title}</span>
                      <Badge variant={status.variant}>{t(status.key as "statusTranslated")}</Badge>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {pages > 1 ? (
            <div className="flex items-center justify-between gap-2 border-t p-3">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => update({ page: page - 1 })}>{t("previous")}</Button>
              <span className="text-body text-muted-foreground">{t("pageOf", { page, pages })}</span>
              <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => update({ page: page + 1 })}>{t("next")}</Button>
            </div>
          ) : null}
        </Card>
        <div className={cn("min-w-0", !selected && "max-lg:hidden")}>
          {selected ? (
            <div className="flex flex-col gap-3">
              <Button variant="ghost" className="self-start lg:hidden" onClick={() => update({ id: undefined })}>
                <ArrowLeft className="size-4" aria-hidden="true" />
                {t("back")}
              </Button>
              <Suspense fallback={<Card className="h-64" />}>
                <TranslationEditor
                  type={type}
                  id={selected}
                  locale={locale}
                  marketId={marketId}
                  canEdit={canEditTranslations(permissions.hasPermission, type)}
                />
              </Suspense>
            </div>
          ) : (
            <Card>
              <EmptyState icon={Languages} title={t("chooseResource")} description={t("chooseResourceHelp")} />
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
