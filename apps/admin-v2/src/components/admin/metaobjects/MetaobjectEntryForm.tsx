// One entry of a content type: an input per field of the type, drawn by the
// field's type exactly as the Custom data card draws it, then its status and
// handle. The page's save bar saves it under the revision the page loaded.
// Publishing needs every required field.
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import {
  customFieldItemType,
  isCustomFieldListType,
  type CustomFieldCodecContext,
  type CustomFieldType,
} from "@scalius/shared/custom-fields";
import { DEFAULT_CURRENCY, getDecimalPlaces } from "@scalius/shared/currency";
import { resolvePriceIncrementMinor } from "@scalius/shared/currency-policy";
import { toast } from "~/lib/toast";
import { ErrorBoundary } from "~/components/admin/ErrorBoundary";
import { CustomFieldInput } from "~/components/admin/custom-fields/CustomFieldInput";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { ReadOnlyNotice } from "~/components/admin/resource/ReadOnlyNotice";
import { StatusBadge } from "~/components/admin/resource/StatusBadge";
import { SettingsField } from "~/components/admin/settings/SettingsPage";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { SaveBarProvider, SaveErrorBanner, useSaveBar, useSaveScope } from "~/components/admin/shared/SaveBar";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { usePermissions } from "~/contexts/PermissionContext";
import { useCurrency } from "~/hooks/use-currency";
import { useMessages } from "~/i18n";
import { customFieldMessages, type CustomFieldMessageKey } from "~/i18n/custom-fields";
import { metaobjectMessages } from "~/i18n/metaobjects";
import { saveBarMessages } from "~/i18n/save-bar";
import { getServerFnError } from "~/lib/api-helpers";
import {
  createMetaobjectEntry,
  metaobjectEntryQueryOptions,
  metaobjectKeys,
  saveMetaobjectEntry,
  useDeleteMetaobjectEntry,
  type MetaobjectDefinition,
  type MetaobjectEntry,
} from "~/lib/api-query-options/metaobjects";
import type { DraftProblem } from "~/components/admin/custom-fields/custom-field-draft";
import { throwMetaobjectSaveError } from "./metaobject-errors";
import {
  changedKeys,
  createEntryBody,
  entryFormOf,
  entryProblems,
  hasEntryProblems,
  sameEntryForm,
  updateEntryBody,
  type EntryForm,
} from "./metaobject-entry-form";

export function MetaobjectEntryForm({ definition, entry }: { definition: MetaobjectDefinition; entry: MetaobjectEntry | null }) {
  const t = useMessages(metaobjectMessages);
  return (
    <ErrorBoundary>
      <SaveBarProvider savedMessage={t(entry ? "entrySaved" : "entryCreated")} unsavedLabel={entry ? undefined : t("addEntryTitle")}>
        <EntryFormPage definition={definition} initial={entry} />
      </SaveBarProvider>
    </ErrorBoundary>
  );
}

function EntryFormPage({ definition, initial }: { definition: MetaobjectDefinition; initial: MetaobjectEntry | null }) {
  const t = useMessages(metaobjectMessages);
  const bar = useMessages(saveBarMessages);
  const cf = useMessages(customFieldMessages);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canEdit = usePermissions().hasPermission(PERMISSIONS.METAOBJECTS_EDIT);
  const scope = useSaveScope();
  const revealed = Boolean(scope?.revealed);
  const currency = useCurrency();
  const currencyCode = currency.code ?? DEFAULT_CURRENCY.code;
  const priceIncrementMinor = resolvePriceIncrementMinor(currencyCode, currency.priceIncrementMinor);
  // Money values are checked against the store's price increment, as the server does.
  const context = useMemo<CustomFieldCodecContext>(
    () => ({ decimalPlaces: getDecimalPlaces(currencyCode), currencyCode, priceIncrementMinor }),
    [currencyCode, priceIncrementMinor],
  );

  const [saved, setSaved] = useState<MetaobjectEntry | null>(initial);
  const [base, setBase] = useState<EntryForm>(() => entryFormOf(definition, initial));
  const [form, setForm] = useState<EntryForm>(base);
  const [deleting, setDeleting] = useState(false);
  const problems = entryProblems(definition, form, context);
  const edited = changedKeys(definition, form, base);
  const dirty = canEdit && !sameEntryForm(definition, form, base);
  const listUrl = `/admin/metaobjects/${definition.id}`;

  const problemText = (type: CustomFieldType, problem: DraftProblem): string => {
    const code = `issue.${problem.issue.code}` as CustomFieldMessageKey;
    const message = cf(code in customFieldMessages.en ? code : "issue.invalid", {
      type: cf(`type.${customFieldItemType(type)}` as CustomFieldMessageKey),
      limit: problem.issue.limit ?? "",
    });
    return problem.issue.index === undefined ? message : cf("itemIssue", { index: problem.issue.index + 1, message });
  };

  useSaveBar({
    label: t("entryDetails"),
    dirty,
    invalid: !canEdit || hasEntryProblems(problems),
    fields: (path) => {
      if (path === "handle") return "metaobject-entry-handle";
      const key = /^fields\.([^.]+)/.exec(path)?.[1];
      return key && definition.fields.some((field) => field.key === key) ? `metaobject-entry-${key}` : undefined;
    },
    save: async () => {
      const sent = form;
      try {
        if (!saved) {
          await createMetaobjectEntry(definition.id, createEntryBody(definition, sent));
          void queryClient.invalidateQueries({ queryKey: metaobjectKeys.all });
          // The leave guard stands down while the save runs.
          setBase(sent);
          await navigate({ to: "/admin/metaobjects/$definitionId", params: { definitionId: definition.id }, replace: true });
          return;
        }
        const next = await saveMetaobjectEntry(definition.id, saved.id, updateEntryBody(definition, sent, base, saved.revision));
        const fresh = entryFormOf(definition, next);
        setSaved(next);
        setBase(fresh);
        // Edits typed while the save was on its way stay; otherwise the form shows what was stored.
        setForm((current) => (sameEntryForm(definition, current, sent) ? fresh : current));
        queryClient.setQueryData(metaobjectEntryQueryOptions(definition.id, next.id).queryKey, next);
        void queryClient.invalidateQueries({ queryKey: metaobjectKeys.entries(definition.id) });
      } catch (error) {
        throwMetaobjectSaveError(error, "entry");
        throw error;
      }
    },
    discard: () => setForm(base),
    // After a conflict: the latest saved entry is the base; these edits stay.
    reload: async () => {
      if (!saved) return;
      const latest = await queryClient.fetchQuery({ ...metaobjectEntryQueryOptions(definition.id, saved.id), staleTime: 0 });
      setSaved(latest);
      setBase(entryFormOf(definition, latest));
    },
  });

  const title = saved ? saved.displayName || t("untitledEntry") : t("addEntryTitle");
  const setField = (key: string, draft: EntryForm["fields"][string]) =>
    setForm((current) => ({ ...current, fields: { ...current.fields, [key]: draft } }));

  return (
    <div className="pb-6">
      <PageHeader
        backTo={listUrl}
        title={title}
        badge={saved ? <StatusBadge status={base.status === "published" ? "active" : "draft"}>{t(base.status)}</StatusBadge> : undefined}
      />
      <div className="flex flex-col gap-4">
        <SaveErrorBanner />
        {canEdit ? null : <ReadOnlyNotice />}
        <fieldset disabled={!canEdit} className="min-w-0">
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="min-w-0 lg:col-span-2">
              <CardHeader>
                <CardTitle>{definition.name}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {definition.fields.map((field) => {
                  const id = `metaobject-entry-${field.key}`;
                  const type = field.type as CustomFieldType;
                  const typeLabel = cf(`type.${customFieldItemType(type)}` as CustomFieldMessageKey);
                  const found = problems.fields[field.key];
                  // A value that cannot be read shows as it is typed; a missing required value waits for Save.
                  const problem = !found ? null : found.kind === "required"
                    ? (revealed ? t("requiredToPublish") : null)
                    : edited.includes(field.key) || revealed ? problemText(type, found.problem) : null;
                  const note = problem ?? field.description ?? null;
                  return (
                    <div key={field.key} className="space-y-1.5">
                      <Label htmlFor={id}>
                        {field.name}
                        {field.required ? <span className="font-normal text-muted-foreground"> ({t("requiredMark")})</span> : null}
                        <span className="sr-only"> ({isCustomFieldListType(type) ? cf("listOf", { type: typeLabel }) : typeLabel})</span>
                      </Label>
                      <CustomFieldInput
                        id={id}
                        type={type}
                        validations={{}}
                        draft={form.fields[field.key] ?? (isCustomFieldListType(type) ? [] : "")}
                        onChange={(draft) => setField(field.key, draft)}
                        disabled={!canEdit}
                        invalid={Boolean(problem)}
                        describedBy={note ? `${id}-note` : undefined}
                        label={field.name}
                      />
                      {note ? (
                        <p id={`${id}-note`} className={problem ? "text-body text-destructive" : "text-body text-muted-foreground"}>{note}</p>
                      ) : null}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
            <div className="min-w-0 space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>{t("entryStatus")}</CardTitle>
                </CardHeader>
                <CardContent>
                  <RadioGroup
                    aria-label={t("entryStatus")}
                    value={form.status}
                    onValueChange={(status) => setForm((current) => ({ ...current, status: status === "published" ? "published" : "draft" }))}
                  >
                    {(["draft", "published"] as const).map((status) => (
                      <label key={status} className="flex min-h-11 items-start gap-2 py-1 text-body">
                        <span className="flex h-lh items-center"><RadioGroupItem value={status} /></span>
                        <span>
                          <span className="block font-medium">{t(status)}</span>
                          <span className="block text-muted-foreground">{t(status === "draft" ? "statusDraftHelp" : "statusPublishedHelp")}</span>
                        </span>
                      </label>
                    ))}
                  </RadioGroup>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>{t("entryHandle")}</CardTitle>
                </CardHeader>
                <CardContent>
                  <SettingsField
                    id="metaobject-entry-handle"
                    label={t("entryHandle")}
                    help={saved ? t("entryHandleSaved") : t("entryHandleNew")}
                    error={problems.handle ? t("handleInvalid") : undefined}
                  >
                    <Input
                      id="metaobject-entry-handle"
                      value={form.handle}
                      maxLength={100}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => setForm((current) => ({ ...current, handle: event.target.value.toLowerCase().replace(/\s+/g, "-") }))}
                    />
                  </SettingsField>
                </CardContent>
              </Card>
            </div>
          </div>
        </fieldset>
        {canEdit ? (
          <div className="flex flex-wrap justify-between gap-2 border-t pt-4">
            {saved ? <Button type="button" variant="destructive" onClick={() => setDeleting(true)}>{t("deleteEntry")}</Button> : <span />}
            <Button type="button" loading={Boolean(scope?.busy)} disabled={!scope?.dirty} onClick={() => void scope?.saveAll()}>
              {saved ? bar("save") : t("addEntry")}
            </Button>
          </div>
        ) : null}
      </div>
      {canEdit && saved ? <DeleteEntry definition={definition} entry={saved} open={deleting} onOpenChange={setDeleting} /> : null}
    </div>
  );
}

function DeleteEntry({ definition, entry, open, onOpenChange }: {
  definition: MetaobjectDefinition;
  entry: MetaobjectEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useMessages(metaobjectMessages);
  const navigate = useNavigate();
  const remove = useDeleteMetaobjectEntry(definition.id);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("deleteEntryTitle", { name: entry.displayName || t("untitledEntry") })}
      description={t("deleteEntryBody")}
      confirmLabel={t("deleteEntry")}
      cancelLabel={t("cancel")}
      loadingLabel={t("deletingEntry")}
      isLoading={remove.isPending}
      onConfirm={() =>
        remove.mutate(entry, {
          onSuccess: async () => {
            toast.success(t("entryDeleted"));
            onOpenChange(false);
            await navigate({ to: "/admin/metaobjects/$definitionId", params: { definitionId: definition.id }, replace: true });
          },
          onError: (error) => void toast.error(getServerFnError(error, t("deleteEntryFailed"))),
        })}
    />
  );
}
