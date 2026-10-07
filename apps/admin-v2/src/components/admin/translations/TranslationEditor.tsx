// Translate & adapt's editor (docs/MARKETS-DESIGN.md D9), Shopify's side by
// side: each field's default-language text beside its translation, an
// Outdated badge where the source changed since, the translated web address,
// a product's options and values, machine translation through an app, save
// and delete. It loads on demand (Translate & adapt downloads it only when an
// item opens).
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Languages } from "lucide-react";
import { RichContent } from "~/components/ui/rich-content";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Skeleton } from "~/components/ui/skeleton";
import { Textarea } from "~/components/ui/textarea";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { useLocale, useMessages } from "~/i18n";
import { translationsMessages } from "~/i18n/translations";
import { resourceMessages } from "~/i18n/resource";
import { getServerFnError } from "~/lib/api-helpers";
import { toast } from "~/lib/toast";
import {
  resourceTranslationsQueryOptions,
  translationProvidersQueryOptions,
  useDeleteTranslation,
  useMachineTranslate,
  useSaveTranslation,
  type ResourceTranslationsView,
  type TranslationEditorType,
} from "~/lib/api-query-options/translations";
import {
  STATUS_BADGE,
  draftKey,
  initialDraft,
  isDirty,
  languageName,
  resourcePath,
  saveBody,
  translationRows,
  type TranslationRow,
} from "./translation-form";

export interface TranslationEditorProps {
  type: TranslationEditorType;
  id: string;
  locale: string;
  marketId: string | null;
  canEdit: boolean;
}

export function TranslationEditor(props: TranslationEditorProps) {
  const t = useMessages(translationsMessages);
  const r = useMessages(resourceMessages);
  const view = useQuery(resourceTranslationsQueryOptions(props.type, props.id, props.locale, props.marketId));
  if (view.isError) {
    return (
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <p className="text-body">{t("editorLoadFailed")}</p>
        <Button variant="outline" size="sm" onClick={() => void view.refetch()}>{r("retry")}</Button>
      </Card>
    );
  }
  if (!view.data) return <EditorSkeleton />;
  // A fresh draft for each saved state: switching items never carries edits over.
  return <EditorForm key={`${props.type}:${props.id}:${props.locale}:${props.marketId ?? ""}`} {...props} view={view.data} />;
}

function EditorSkeleton() {
  const rows = [0, 1, 2].map((index) => (
    <div key={index} className="grid gap-2 md:grid-cols-2">
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  ));
  return <Card className="space-y-4 p-4">{rows}</Card>;
}

function EditorForm({ type, id, locale, marketId, canEdit, view }: TranslationEditorProps & { view: ResourceTranslationsView }) {
  const t = useMessages(translationsMessages);
  const uiLocale = useLocale();
  const providers = useQuery(translationProvidersQueryOptions());
  const save = useSaveTranslation(type, id);
  const remove = useDeleteTranslation(type, id);
  const machine = useMachineTranslate();
  const rows = useMemo(() => translationRows(view), [view]);
  const [draft, setDraft] = useState<Record<string, string>>(() => initialDraft(view));
  const [slug, setSlug] = useState<string>(view.resource.slug ?? "");
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    setDraft(initialDraft(view));
    setSlug(view.resource.slug ?? "");
  }, [view]);

  const sourceLocale = providers.data?.defaultLocale ?? "";
  const sourceName = sourceLocale ? languageName(sourceLocale, uiLocale) : "";
  const targetName = languageName(locale, uiLocale);
  const dirty = isDirty(view, draft, slug);
  const status = STATUS_BADGE[view.resource.status];
  const slugPath = view.resource.sourceSlug ? resourcePath(type, view.resource.sourceSlug, view.resource.subtitle) : null;
  const provider = providers.data?.items[0] ?? null;
  const emptyRows = rows.filter((row) => !(draft[draftKey(row)] ?? "").trim());

  const onSave = () => {
    save.mutate(saveBody(view, draft, { locale, marketId, slug: slug.trim() || null }), {
      onSuccess: () => toast.success(t("saved")),
      onError: (error) => toast.error(getServerFnError(error, t("saveFailed"))),
    });
  };

  const onMachineTranslate = () => {
    if (!provider || emptyRows.length === 0) return;
    machine.mutate({
      providerId: provider.id,
      locale,
      texts: emptyRows.slice(0, 100).map((row) => ({ key: draftKey(row), text: row.source, format: row.kind === "html" ? "html" as const : "text" as const })),
    }, {
      onSuccess: (texts) => {
        setDraft((current) => {
          const next = { ...current };
          for (const text of texts) if (!(next[text.key] ?? "").trim()) next[text.key] = text.text;
          return next;
        });
        toast.success(t("machineDone"));
      },
      onError: (error) => toast.error(getServerFnError(error, t("machineFailed"))),
    });
  };

  const body = (
    <>
      <div className="flex flex-col gap-4">
        {rows.length === 0 && view.resource.sourceSlug === null ? (
          <p className="text-body text-muted-foreground">{t("noSourceText")}</p>
        ) : null}
        {rows.map((row, index) => (
          <FieldRow
            key={draftKey(row)}
            row={row}
            first={index === 0}
            value={draft[draftKey(row)] ?? ""}
            onChange={(value) => setDraft((current) => ({ ...current, [draftKey(row)]: value }))}
            disabled={!canEdit}
            sourceName={sourceName}
            targetName={targetName}
          />
        ))}
        {view.resource.sourceSlug !== null ? (
          <div className="grid gap-2 border-t pt-4 md:grid-cols-2 md:gap-4">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-body font-medium">{t("field_slug")}</span>
              <code className="break-all text-muted-foreground">{slugPath}</code>
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <Label htmlFor={`slug-${id}`} className="sr-only">{t("field_slug")}</Label>
              <Input
                id={`slug-${id}`}
                value={slug}
                onChange={(event) => setSlug(event.target.value.toLowerCase())}
                disabled={!canEdit || marketId !== null}
                maxLength={100}
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-body text-muted-foreground">
                {marketId !== null ? t("slugMarketHelp") : t("slugHelp", { path: slugPath ?? "" })}
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </>
  );

  const actions = canEdit ? (
    <div className="flex w-full flex-wrap items-center justify-end gap-2">
      {view.resource.translation ? (
        <Button type="button" variant="ghost" className="me-auto" onClick={() => setDeleting(true)}>
          {t("deleteTranslation")}
        </Button>
      ) : null}
      {provider && emptyRows.length > 0 ? (
        <Button type="button" variant="outline" loading={machine.isPending} onClick={onMachineTranslate} title={t("machineHelp")}>
          <Languages className="size-4" aria-hidden="true" />
          {t("translateWith", { provider: provider.name })}
        </Button>
      ) : null}
      <Button type="button" loading={save.isPending} disabled={!dirty} onClick={onSave}>{t("save")}</Button>
    </div>
  ) : null;

  const confirm = (
    <ConfirmDialog
      open={deleting}
      onOpenChange={setDeleting}
      title={t("deleteTitle", { language: targetName })}
      description={t("deleteDescription")}
      confirmLabel={t("deleteConfirm")}
      cancelLabel={t("cancel")}
      variant="destructive"
      isLoading={remove.isPending}
      onConfirm={() => remove.mutate({ locale, marketId }, {
        onSuccess: () => {
          setDeleting(false);
          toast.success(t("deleted"));
        },
        onError: (error) => toast.error(getServerFnError(error, t("deleteFailed"))),
      })}
    />
  );

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center gap-2">
        <CardTitle className="min-w-0 break-words">{view.resource.title}</CardTitle>
        <Badge variant={status.variant}>{t(status.key as "statusTranslated")}</Badge>
        {dirty ? <Badge variant="attention">{t("unsaved")}</Badge> : null}
      </CardHeader>
      <CardContent>{body}</CardContent>
      {actions ? <CardFooter>{actions}</CardFooter> : null}
      {confirm}
    </Card>
  );
}

function FieldRow({ row, first, value, onChange, disabled, sourceName, targetName }: {
  row: TranslationRow;
  first: boolean;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  sourceName: string;
  targetName: string;
}) {
  const t = useMessages(translationsMessages);
  const label = t(row.label.key as "field_name", row.label.vars);
  const inputId = `tr-${row.type}-${row.id}-${row.field}`.replace(/[^A-Za-z0-9_-]/g, "-");
  return (
    <div className={first ? "flex flex-col gap-2" : "flex flex-col gap-2 border-t pt-4"}>
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={inputId}>{label}</Label>
        {row.outdated ? (
          <Badge variant="warning" title={t("outdatedHelp", { language: sourceName })}>{t("outdated")}</Badge>
        ) : null}
      </div>
      <div className="grid gap-2 md:grid-cols-2 md:gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          {sourceName ? <span className="text-body text-muted-foreground">{t("source", { language: sourceName })}</span> : null}
          <div className="max-h-64 overflow-y-auto rounded-lg bg-muted px-3 py-2">
            {row.kind === "html"
              ? <RichContent content={row.source} />
              : <p className="whitespace-pre-wrap break-words text-body">{row.source}</p>}
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-body text-muted-foreground">{t("translation", { language: targetName })}</span>
          {row.kind === "html" ? (
            disabled
              ? <div className="rounded-lg border px-3 py-2"><RichContent content={value} /></div>
              : (
                <>
                  <Textarea id={inputId} value={value} onChange={(event) => onChange(event.target.value)} maxLength={row.max} rows={6} />
                  <span className="text-body text-muted-foreground">{t("htmlSourceHint")}</span>
                </>
              )
          ) : row.kind === "text" ? (
            <Textarea id={inputId} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} maxLength={row.max} rows={3} />
          ) : (
            <Input id={inputId} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} maxLength={row.max} />
          )}
        </div>
      </div>
    </div>
  );
}
