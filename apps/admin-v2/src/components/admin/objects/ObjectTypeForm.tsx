// A content type (Shopify's object definition): its name, handle, field
// rows, the field that names entries and whether the online store may show it.
// The page's save bar saves it under the revision the page loaded. A type an
// app owns is shown read-only ("Managed by <app>"): only the app changes it.
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import {
  customFieldItemType,
  isCustomFieldKey,
  isCustomFieldListType,
} from "@scalius/shared/custom-fields";
import { OBJECT_FIELD_TYPES, OBJECT_FIELDS_MAX, OBJECT_MERCHANT_NAMESPACE } from "@scalius/shared/plugins/objects";
import { toast } from "~/lib/toast";
import { ErrorBoundary } from "~/components/admin/ErrorBoundary";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { ReadOnlyNotice } from "~/components/admin/resource/ReadOnlyNotice";
import { SettingsField } from "~/components/admin/settings/SettingsPage";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { SaveBarProvider, SaveErrorBanner, useSaveBar, useSaveScope } from "~/components/admin/shared/SaveBar";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { usePermissions } from "~/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { customFieldMessages, type CustomFieldMessageKey } from "~/i18n/custom-fields";
import { objectMessages, type ObjectMessageKey } from "~/i18n/objects";
import { saveBarMessages } from "~/i18n/save-bar";
import { getServerFnError } from "~/lib/api-helpers";
import {
  createObjectType,
  objectTypeQueryOptions,
  objectKeys,
  saveObjectType,
  useDeleteObjectType,
  type ObjectType,
  type ObjectField,
  objectTypesQueryOptions,
} from "~/lib/api-query-options/objects";
import { throwObjectSaveError } from "./object-errors";
import {
  OBJECT_DESCRIPTION_MAX,
  OBJECT_NAME_MAX,
  blankRow,
  createTypeBody,
  emptyTypeDraft,
  hasTypeProblems,
  moveRow,
  typeDraftOf,
  typeDraftProblems,
  typeDraftSnapshot,
  updateTypeBody,
  withName,
  withRowName,
  type FieldRowDraft,
  type TypeDraft,
  type TypeProblemCode,
} from "./object-form";
import { useAppName } from "./use-app-name";
import { ChoiceField, FieldRow } from "~/components/ui/field";
import { Page } from "~/components/admin/resource/Page";

export function ObjectTypeForm({ definition }: { definition: ObjectType | null }) {
  const t = useMessages(objectMessages);
  return (
    <ErrorBoundary>
      <SaveBarProvider savedMessage={t(definition ? "typeSaved" : "typeCreated")} unsavedLabel={definition ? undefined : t("createTitle")}>
        <TypeFormPage initial={definition} />
      </SaveBarProvider>
    </ErrorBoundary>
  );
}

/** Lowercase, with spaces as underscores: what a key or handle is typed as. */
const keyText = (value: string) => value.toLowerCase().replace(/\s+/g, "_");

function TypeFormPage({ initial }: { initial: ObjectType | null }) {
  const t = useMessages(objectMessages);
  const bar = useMessages(saveBarMessages);
  const types = useMessages(customFieldMessages);
  const queryClient = useQueryClient();
  const objectTypes = useQuery(objectTypesQueryOptions());
  const navigate = useNavigate();
  const canEditAll = usePermissions().hasPermission(PERMISSIONS.OBJECTS_EDIT);
  const scope = useSaveScope();
  const appOwned = initial?.owner === "app";
  const canEdit = canEditAll && !appOwned;
  const creating = initial === null;
  const appName = useAppName(initial?.namespace ?? "", appOwned);

  const [saved, setSaved] = useState<ObjectType | null>(initial);
  const [base, setBase] = useState<TypeDraft>(() => (initial ? typeDraftOf(initial) : emptyTypeDraft()));
  const [draft, setDraft] = useState<TypeDraft>(base);
  const [deleting, setDeleting] = useState(false);
  const [focusRow, setFocusRow] = useState<string | null>(null);
  const problems = typeDraftProblems(draft, creating);
  const dirty = canEdit && typeDraftSnapshot(draft) !== typeDraftSnapshot(base);
  const recordCount = saved?.recordCount ?? 0;
  const revealed = Boolean(scope?.revealed);

  useEffect(() => {
    if (!focusRow) return;
    document.getElementById(`object-field-${focusRow}-name`)?.focus();
    setFocusRow(null);
  }, [focusRow]);

  const say = (code: TypeProblemCode | undefined) => (code ? t(`problem.${code}` as ObjectMessageKey, { max: OBJECT_FIELDS_MAX }) : undefined);
  const update = (patch: Partial<TypeDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const updateRow = (rowId: string, patch: Partial<FieldRowDraft>) =>
    setDraft((current) => ({ ...current, fields: current.fields.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row)) }));

  /** The control an API body path is shown on. */
  const fieldId = (path: string): string | undefined => {
    if (path === "name") return "object-name";
    if (path === "description") return "object-description";
    const byIndex = /^fields\.(\d+)\.(name|key|type|description)$/.exec(path);
    if (byIndex) {
      const row = draft.fields[Number(byIndex[1])];
      return row ? `object-field-${row.rowId}-${byIndex[2]}` : undefined;
    }
    const byKey = /^fields\.([a-z][a-z0-9_]*)\.type$/.exec(path);
    const row = byKey ? draft.fields.find((each) => each.key === byKey[1]) : undefined;
    return row ? `object-field-${row.rowId}-type` : undefined;
  };

  useSaveBar({
    label: t("detailsTitle"),
    dirty,
    invalid: !canEdit || hasTypeProblems(problems),
    fields: fieldId,
    save: async () => {
      const sent = draft;
      // After a save every row is on the saved type: its key stays.
      const settled: TypeDraft = { ...sent, handleEdited: true, fields: sent.fields.map((row) => ({ ...row, saved: true, keyEdited: true })) };
      try {
        if (!saved) {
          const created = await createObjectType(createTypeBody(sent));
          queryClient.setQueryData(objectKeys.definition(created.handle), created);
          void queryClient.invalidateQueries({ queryKey: objectKeys.definitions() });
          // The leave guard stands down while the save runs; the new type opens on its entries.
          setBase(settled);
          await navigate({ to: "/admin/objects/$type", params: { type: created.handle }, replace: true });
          return;
        }
        const next = await saveObjectType(saved.handle, updateTypeBody(sent, saved.revision, saved));
        setSaved(next);
        setBase(settled);
        setDraft((current) => ({
          ...current,
          fields: current.fields.map((row) => (sent.fields.some((each) => each.rowId === row.rowId) ? { ...row, saved: true, keyEdited: true } : row)),
        }));
        queryClient.setQueryData(objectKeys.definition(next.handle), next);
        void queryClient.invalidateQueries({ queryKey: objectKeys.definitions() });
      } catch (error) {
        throwObjectSaveError(error, "type");
        throw error;
      }
    },
    discard: () => setDraft(base),
    // After a conflict: the latest saved type is the base; these edits stay.
    reload: async () => {
      if (!saved) return;
      const latest = await queryClient.fetchQuery({ ...objectTypeQueryOptions(saved.handle), staleTime: 0 });
      setSaved(latest);
      setBase(typeDraftOf(latest));
    },
  });

  const binding = `${saved?.namespace ?? OBJECT_MERCHANT_NAMESPACE}.${draft.handle || "handle"}`;
  const fieldTypes = OBJECT_FIELD_TYPES;
  const typeLabel = (type: ObjectField["type"]) => {
    if (type === "customer_reference" || type === "order_reference" || type === "object_reference" || type === "list.object_reference") return t(`fieldType.${type}`);
    const item = types(`type.${customFieldItemType(type)}` as CustomFieldMessageKey);
    return isCustomFieldListType(type) ? types("listOf", { type: item }) : item;
  };
  const rowName = (row: FieldRowDraft, index: number) => row.name.trim() || t("unnamedField", { number: index + 1 });
  const displayOptions = [
    { value: "", label: t("displayAuto") },
    ...draft.fields
      .filter((row) => isCustomFieldKey(row.key.trim()))
      .map((row) => ({ value: row.key.trim(), label: row.name.trim() || row.key.trim() })),
  ];
  const displayValue = displayOptions.some((option) => option.value === draft.display) ? draft.display : "";
  const title = creating ? t("createTitle") : base.name || saved?.name || "";

  return (
    <Page width="form" className="pb-6">
      <PageHeader
        backTo={saved ? `/admin/objects/${saved.handle}` : "/admin/objects"}
        title={title}
      />
      <div className="flex flex-col gap-4">
        <SaveErrorBanner />
        {appOwned ? (
          <Alert variant="info">
            <AlertDescription>
              <p className="font-medium">{t("appManagedTitle", { app: appName })}</p>
              <p>{t("appManagedHelp")}</p>
            </AlertDescription>
          </Alert>
        ) : canEditAll ? null : <ReadOnlyNotice />}
        <fieldset disabled={!canEdit} className="min-w-0">
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="min-w-0 space-y-4 lg:col-span-2">
              <Card>
                <CardHeader>
                  <CardTitle>{t("detailsTitle")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <SettingsField id="object-name" label={t("name")} help={t("nameHelp")} error={say(problems.name)}>
                    <Input
                      id="object-name"
                      value={draft.name}
                      maxLength={OBJECT_NAME_MAX}
                      autoComplete="off"
                      onChange={(event) => setDraft((current) => withName(current, event.target.value))}
                    />
                  </SettingsField>
                  <SettingsField
                    id="object-handle"
                    label={t("handle")}
                    help={creating ? t("handleHelp", { binding }) : t("handleFixed", { binding })}
                    error={say(problems.handle)}
                  >
                    <Input
                      id="object-handle"
                      value={draft.handle}
                      maxLength={48}
                      disabled={!creating}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => update({ handle: keyText(event.target.value), handleEdited: true })}
                    />
                  </SettingsField>
                  <SettingsField id="object-description" label={t("description")} help={t("descriptionHelp")}>
                    <Textarea
                      id="object-description"
                      rows={2}
                      value={draft.description}
                      maxLength={OBJECT_DESCRIPTION_MAX}
                      onChange={(event) => update({ description: event.target.value })}
                    />
                  </SettingsField>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>{t("fieldsTitle")}</CardTitle>
                  <CardDescription>{t("fieldsHelp")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {draft.fields.map((row, index) => {
                    const rowProblems = problems.rows[row.rowId];
                    const name = rowName(row, index);
                    const rid = `object-field-${row.rowId}`;
                    const typeFixed = row.saved && recordCount > 0;
                    return (
                      <section key={row.rowId} aria-label={t("fieldNumber", { number: index + 1 })} className="space-y-3 border-t border-border pt-4 first:border-t-0 first:pt-0">
                        <div className="flex items-center gap-1">
                          <p className="min-w-0 flex-1 text-heading-sm">{t("fieldNumber", { number: index + 1 })}</p>
                          <Button type="button" variant="ghost" size="icon-sm" aria-label={t("moveFieldUp", { name })} disabled={index === 0} onClick={() => update({ fields: moveRow(draft.fields, index, -1) })}>
                            <ArrowUp aria-hidden="true" />
                          </Button>
                          <Button type="button" variant="ghost" size="icon-sm" aria-label={t("moveFieldDown", { name })} disabled={index === draft.fields.length - 1} onClick={() => update({ fields: moveRow(draft.fields, index, 1) })}>
                            <ArrowDown aria-hidden="true" />
                          </Button>
                          <Button type="button" variant="ghost" size="icon-sm" aria-label={t("removeField", { name })} disabled={draft.fields.length <= 1} onClick={() => update({ fields: draft.fields.filter((each) => each.rowId !== row.rowId) })}>
                            <Trash2 aria-hidden="true" />
                          </Button>
                        </div>
                        <FieldRow>
                          <SettingsField id={`${rid}-name`} label={t("fieldName")} error={say(rowProblems?.name)}>
                            <Input
                              id={`${rid}-name`}
                              value={row.name}
                              maxLength={OBJECT_NAME_MAX}
                              autoComplete="off"
                              onChange={(event) => setDraft((current) => withRowName(current, row.rowId, event.target.value))}
                            />
                          </SettingsField>
                          <SettingsField id={`${rid}-type`} label={t("fieldType")} help={typeFixed ? t("fieldTypeFixed") : undefined}>
                            <SearchableSelect
                              id={`${rid}-type`}
                              triggerClassName="w-full"
                              value={row.type}
                              disabled={typeFixed}
                              options={fieldTypes.map((type) => ({ value: type, label: typeLabel(type) }))}
                              onValueChange={(value) => {
                                const next = fieldTypes.find((type) => type === value);
                                if (next) updateRow(row.rowId, { type: next, indexed: next === "json" || next.startsWith("list.") ? false : row.indexed });
                              }}
                            />
                          </SettingsField>
                          <SettingsField
                            id={`${rid}-key`}
                            label={t("fieldKey")}
                            help={row.saved ? t("fieldKeyFixed") : t("fieldKeyHelp")}
                            error={say(rowProblems?.key)}
                          >
                            <Input
                              id={`${rid}-key`}
                              value={row.key}
                              maxLength={64}
                              disabled={row.saved}
                              autoComplete="off"
                              spellCheck={false}
                              onChange={(event) => updateRow(row.rowId, { key: keyText(event.target.value), keyEdited: true })}
                            />
                          </SettingsField>
                          <SettingsField id={`${rid}-description`} label={t("fieldDescription")} help={t("fieldDescriptionHelp")}>
                            <Input
                              id={`${rid}-description`}
                              value={row.description}
                              maxLength={300}
                              autoComplete="off"
                              onChange={(event) => updateRow(row.rowId, { description: event.target.value })}
                            />
                          </SettingsField>
                        </FieldRow>
                        {row.type === "object_reference" || row.type === "list.object_reference" ? (
                          <SettingsField id={`${rid}-to`} label={t("referenceType")}>
                            <SearchableSelect
                              id={`${rid}-to`}
                              value={row.to ?? ""}
                              options={(objectTypes.data ?? []).map((type) => ({ value: type.handle, label: type.name }))}
                              onValueChange={(to) => updateRow(row.rowId, { to })}
                              disabled={typeFixed}
                              triggerClassName="w-full"
                            />
                          </SettingsField>
                        ) : null}
                        <ChoiceField
                          id={`${rid}-indexed`}
                          label={t("indexed")}
                          help={t("indexedHelp")}
                          control={<Checkbox
                            id={`${rid}-indexed`}
                            checked={row.indexed}
                            disabled={row.type === "json" || row.type.startsWith("list.") || (!row.indexed && draft.compoundIndexes.length + draft.fields.filter((field) => field.indexed).length >= 4)}
                            onCheckedChange={(value) => updateRow(row.rowId, { indexed: value === true })}
                          />}
                        />
                        <div className="flex min-h-11 items-center gap-2">
                          <Checkbox id={`${rid}-required`} checked={row.required} onCheckedChange={(value) => updateRow(row.rowId, { required: value === true })} />
                          <Label htmlFor={`${rid}-required`}>{t("fieldRequired")}</Label>
                        </div>
                      </section>
                    );
                  })}
                  {problems.fields && revealed ? <p role="alert" className="text-body text-destructive">{say(problems.fields)}</p> : null}
                  {draft.fields.length < OBJECT_FIELDS_MAX ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const row = blankRow();
                        update({ fields: [...draft.fields, row] });
                        setFocusRow(row.rowId);
                      }}
                    >
                      <Plus aria-hidden="true" />
                      {t("addField")}
                    </Button>
                  ) : null}
                </CardContent>
              </Card>
            </div>
            <div className="min-w-0 space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>{t("displayTitle")}</CardTitle>
                </CardHeader>
                <CardContent>
                  <SettingsField id="object-display" label={t("display")} help={t("displayHelp")}>
                    <SearchableSelect
                      id="object-display"
                      triggerClassName="w-full"
                      value={displayValue}
                      options={displayOptions}
                      onValueChange={(value) => update({ display: value })}
                    />
                  </SettingsField>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>{t("storefrontTitle")}</CardTitle>
                </CardHeader>
                <CardContent>
                  <ChoiceField
                    id="object-storefront"
                    controlAt="end"
                    label={t("storefront")}
                    help={t("storefrontHelp")}
                    control={(
                      <Switch
                        id="object-storefront"
                        checked={draft.storefront}
                        aria-describedby="object-storefront-help"
                        onCheckedChange={(value) => update({ storefront: value })}
                      />
                    )}
                  />
                </CardContent>
              </Card>
            </div>
          </div>
        </fieldset>
        {canEdit ? (
          <div className="flex flex-wrap justify-between gap-2 border-t pt-4">
            {saved ? <Button type="button" variant="destructive" onClick={() => setDeleting(true)}>{t("deleteType")}</Button> : <span />}
            <Button type="button" loading={Boolean(scope?.busy)} disabled={!scope?.dirty} onClick={() => void scope?.saveAll()}>
              {creating ? t("create") : bar("save")}
            </Button>
          </div>
        ) : null}
      </div>
      {canEdit && saved ? <DeleteType definition={saved} open={deleting} onOpenChange={setDeleting} /> : null}
    </Page>
  );
}

function DeleteType({ definition, open, onOpenChange }: { definition: ObjectType; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useMessages(objectMessages);
  const navigate = useNavigate();
  const remove = useDeleteObjectType();
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("deleteTypeTitle", { name: definition.name })}
      description={t("deleteTypeBody", { count: definition.recordCount })}
      confirmLabel={t("deleteType")}
      cancelLabel={t("cancel")}
      loadingLabel={t("deletingType")}
      isLoading={remove.isPending}
      onConfirm={() =>
        remove.mutate(definition, {
          onSuccess: async () => {
            toast.success(t("typeDeleted"));
            onOpenChange(false);
            await navigate({ to: "/admin/objects", replace: true });
          },
          onError: (error) => void toast.error(getServerFnError(error, t("deleteTypeFailed"))),
        })}
    />
  );
}
