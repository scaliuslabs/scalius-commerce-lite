// Settings › Languages (docs/MARKETS-DESIGN.md D9), Shopify's Languages. A
// store with one language sees it in a sentence and one way to add another.
// With more, the default language comes first, then every other one with
// whether it is published, the web address that uses it and how much is
// translated. A language is added unpublished, translated, then published;
// the default can move to another language; a language no web address uses
// can go. Machine translation shows once there is a language to translate to.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { MoreHorizontal } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Label } from "~/components/ui/label";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { useHasPermission } from "~/contexts/PermissionContext";
import { formatNumber, useLocale, useMessages } from "~/i18n";
import { translationsMessages } from "~/i18n/translations";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { getServerFnError } from "~/lib/api-helpers";
import { toast } from "~/lib/toast";
import {
  storeLanguagesQueryOptions,
  useAddStoreLanguage,
  useRemoveStoreLanguage,
  useUpdateStoreLanguage,
  type StoreLanguage,
} from "~/lib/api-query-options/translations";
import { LANGUAGE_CODES, languageName, nativeLanguageName } from "../../translations/translation-form";
import { SettingsCard, SettingsCardLoading } from "../SettingsPage";
import { SettingsLoadFailure } from "../SettingsLoadFailure";
import { AppProviderStatus } from "../AppProviderStatus";
import { appProvidersQuery } from "~/lib/api-query-options/settings-screens";

export function LanguagesSettings() {
  const t = useMessages(translationsMessages);
  const uiLocale = useLocale();
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  const { data, isError, refetch } = useQuery(storeLanguagesQueryOptions());
  const update = useUpdateStoreLanguage();
  const remove = useRemoveStoreLanguage();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<StoreLanguage | null>(null);
  const [defaulting, setDefaulting] = useState<StoreLanguage | null>(null);

  if (isError) return <SettingsLoadFailure title={t("languagesLoadFailed")} onRetry={refetch} />;
  if (!data) return <SettingsCardLoading />;
  const sole = data.length === 1 ? data[0]! : null;

  const name = (locale: string) => languageName(locale, uiLocale);
  const setPublished = (language: StoreLanguage, published: boolean) => update.mutate({ locale: language.locale, published }, {
    onSuccess: () => toast.success(t(published ? "published_toast" : "unpublished_toast")),
    onError: (error) => toast.error(getServerFnError(error, t("updateFailed"))),
  });

  return (
    <>
      <SettingsCard
        id="languages"
        title={t("languagesTitle")}
        description={t("languagesDescription")}
        action={canEdit ? <Button type="button" size="sm" onClick={() => setAdding(true)}>{t("addLanguage")}</Button> : null}
        rows={sole ? (
          <div className="space-y-1 px-4 py-3">
            <p className="flex flex-wrap items-center gap-2">
              <span className="text-body font-medium">{name(sole.locale)}</span>
              <Badge variant="info">{t("default")}</Badge>
            </p>
            <p className="text-body text-muted-foreground">{t("soleSummary", { language: name(sole.locale) })}</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead data-pin="primary">{t("language")}</TableHead>
                <TableHead>{t("status")}</TableHead>
                <TableHead>{t("webAddresses")}</TableHead>
                <TableHead data-numeric="">{t("translated")}</TableHead>
                <TableHead><span className="sr-only">{t("translate")}</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((language) => (
                <TableRow key={language.locale}>
                  <TableCell data-pin="primary">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{name(language.locale)}</span>
                      {language.isDefault ? <Badge variant="info">{t("default")}</Badge> : null}
                    </span>
                    {nativeLanguageName(language.locale) !== name(language.locale) ? (
                      <span className="block text-body text-muted-foreground">{nativeLanguageName(language.locale)}</span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant={language.published ? "success" : "secondary"}>
                      {language.published ? t("published") : t("unpublished")}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {language.presences.length > 0 ? (
                      <span className="flex flex-wrap gap-1">
                        {language.presences.map((presence) => (
                          presence === ""
                            ? <span key="root" className="text-body">{t("rootAddress")}</span>
                            : <code key={presence}>/{presence}</code>
                        ))}
                      </span>
                    ) : <span className="text-muted-foreground">{t("noWebAddress")}</span>}
                  </TableCell>
                  <TableCell data-numeric="">
                    {language.isDefault ? "—" : t("translatedCount", { count: formatNumber(language.translatedResources) })}
                  </TableCell>
                  <TableCell className="text-end">
                    <span className="flex items-center justify-end gap-1">
                      {language.isDefault ? null : (
                        <Button variant="ghost" size="sm" asChild>
                          <Link to="/admin/translations" search={{ locale: language.locale }}>{t("translate")}</Link>
                        </Button>
                      )}
                      {canEdit ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label={t("actionsFor", { language: name(language.locale) })}>
                              <MoreHorizontal className="size-4" aria-hidden="true" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {language.isDefault ? null : (
                              <DropdownMenuItem onSelect={() => setPublished(language, !language.published)}>
                                {language.published ? t("unpublish") : t("publish")}
                              </DropdownMenuItem>
                            )}
                            {language.isDefault ? null : (
                              <DropdownMenuItem onSelect={() => setDefaulting(language)}>{t("makeDefault")}</DropdownMenuItem>
                            )}
                            {language.isDefault ? null : <DropdownMenuSeparator />}
                            <DropdownMenuItem
                              variant="destructive"
                              disabled={language.isDefault || language.presences.length > 0}
                              onSelect={() => setRemoving(language)}
                            >
                              {t("remove")}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      />
      {sole ? null : (
        <>
          <p className="px-1 text-body text-muted-foreground">
            {t("defaultHelp")} <Link to="/admin/settings/markets" className="text-link hover:underline">{t("markets")}</Link>.
          </p>
          <MachineTranslationCard />
        </>
      )}
      <AddLanguageDialog open={adding} onOpenChange={setAdding} taken={data.map((language) => language.locale)} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => { if (!open) setRemoving(null); }}
        title={t("removeTitle", { language: removing ? name(removing.locale) : "" })}
        description={t("removeDescription")}
        confirmLabel={t("removeConfirm")}
        cancelLabel={t("cancel")}
        variant="destructive"
        isLoading={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing.locale, {
          onSuccess: () => {
            setRemoving(null);
            toast.success(t("languageRemoved"));
          },
          onError: (error) => toast.error(getServerFnError(error, t("inUse"))),
        })}
      />
      <ConfirmDialog
        open={defaulting !== null}
        onOpenChange={(open) => { if (!open) setDefaulting(null); }}
        title={t("makeDefaultTitle", { language: defaulting ? name(defaulting.locale) : "" })}
        description={t("makeDefaultDescription", { language: defaulting ? name(defaulting.locale) : "" })}
        confirmLabel={t("makeDefaultConfirm")}
        cancelLabel={t("cancel")}
        isLoading={update.isPending}
        onConfirm={() => defaulting && update.mutate({ locale: defaulting.locale, isDefault: true }, {
          onSuccess: () => {
            setDefaulting(null);
            toast.success(t("defaultChanged"));
          },
          onError: (error) => toast.error(getServerFnError(error, t("updateFailed"))),
        })}
      />
    </>
  );
}

/** Settings › Languages › Machine translation: the translation providers of installed apps (none is built in). */
function MachineTranslationCard() {
  const t = useMessages(translationsMessages);
  const providers = useQuery(appProvidersQuery("translation"));
  return (
    <SettingsCard id="machineTranslation" title={t("machineTitle")} description={t("machineDescription")}>
      {providers.data && providers.data.length > 0 ? (
        <div className="flex flex-col gap-4">
          {providers.data.map((provider) => <AppProviderStatus key={provider.id} provider={provider} />)}
        </div>
      ) : providers.isPending ? null : (
        <p className="text-body text-muted-foreground">
          {t("machineEmpty")} <Link to="/admin/apps" className="text-link hover:underline">{t("browseApps")}</Link>
        </p>
      )}
    </SettingsCard>
  );
}

function AddLanguageDialog({ open, onOpenChange, taken }: { open: boolean; onOpenChange: (open: boolean) => void; taken: readonly string[] }) {
  const t = useMessages(translationsMessages);
  const uiLocale = useLocale();
  const add = useAddStoreLanguage();
  const [locale, setLocale] = useState("");
  const [publish, setPublish] = useState(false);
  const options = LANGUAGE_CODES
    .filter((code) => !taken.includes(code))
    .map((code) => ({ value: code, label: languageName(code, uiLocale), description: nativeLanguageName(code), keywords: [code] }))
    .sort((left, right) => left.label.localeCompare(right.label, uiLocale));
  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setLocale("");
      setPublish(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("addTitle")}</DialogTitle>
          <DialogDescription>{t("addDescription")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="add-language">{t("language")}</Label>
            <SearchableSelect
              id="add-language"
              value={locale}
              options={options}
              placeholder={t("chooseLanguage")}
              searchPlaceholder={t("searchLanguages")}
              emptyMessage={t("noLanguageFound")}
              onValueChange={(value) => setLocale(value)}
            />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="add-language-publish" checked={publish} onCheckedChange={(checked) => setPublish(checked === true)} />
            <Label htmlFor="add-language-publish">{t("publishNow")}</Label>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => close(false)}>{t("cancel")}</Button>
          <Button
            type="button"
            disabled={!locale}
            loading={add.isPending}
            onClick={() => add.mutate({ locale, published: publish }, {
              onSuccess: () => {
                close(false);
                toast.success(t("languageAdded"));
              },
              onError: (error) => toast.error(getServerFnError(error, t("updateFailed"))),
            })}
          >
            {t("add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
