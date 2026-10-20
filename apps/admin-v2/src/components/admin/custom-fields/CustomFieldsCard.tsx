// The Custom data card (COMMERCE-HOOKS H4): one input per custom field of
// the owner type, generated from its definitions, checked with the shared
// codec as the merchant types and saved in one all-or-nothing request.
// Inside an editor's save scope it saves with the page's save bar; on a page
// without one (the order page) it shows its own Save and Discard. A plugin's
// fields are shown read-only: only the plugin writes its namespace.
import { InlineError } from "~/components/admin/states/InlineError";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "~/lib/toast";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import {
  MERCHANT_CUSTOM_FIELD_WRITER,
  canWriteCustomFieldNamespace,
  isCustomFieldListType,
  customFieldItemType,
  type CustomFieldCodecContext,
  type CustomFieldOwnerType,
} from "@scalius/shared/custom-fields";
import { DEFAULT_CURRENCY, getDecimalPlaces } from "@scalius/shared/currency";
import { resolvePriceIncrementMinor } from "@scalius/shared/currency-policy";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import {
  SaveConflict,
  SaveErrorBanner,
  SaveNotCompleted,
  SaveScope,
  useSaveBar,
  type SaveScopeState,
} from "~/components/admin/shared/SaveBar";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Skeleton } from "~/components/ui/skeleton";
import { usePermissions } from "~/contexts/PermissionContext";
import { useCurrency } from "~/hooks/use-currency";
import { useMessages } from "~/i18n";
import { customFieldMessages, type CustomFieldMessageKey } from "~/i18n/custom-fields";
import { saveBarMessages } from "~/i18n/save-bar";
import { AdminApiResponseError, isAdminApiConflictError } from "~/lib/admin-api-error";
import { getServerFnError } from "~/lib/api-helpers";
import {
  customFieldValuesQueryOptions,
  saveCustomFieldValues,
  type CustomFieldEntry,
  type CustomFieldOwnerValues,
} from "~/lib/api-query-options/custom-fields";
import { checkDraft, draftFromValue, sameDraft, valueFromDraft, type CustomFieldDraft, type DraftProblem } from "./custom-field-draft";
import { CustomFieldInput } from "./CustomFieldInput";
import { SavedCustomFieldValue } from "./SavedCustomFieldValue";

type Drafts = Record<string, CustomFieldDraft>;

function draftsOf(fields: readonly CustomFieldEntry[]): Drafts {
  return Object.fromEntries(fields.map((field) => [field.definition.id, draftFromValue(field.definition.type, field.value)]));
}

const writable = (field: CustomFieldEntry) => canWriteCustomFieldNamespace(MERCHANT_CUSTOM_FIELD_WRITER, field.definition.namespace);

/** A codec issue as the merchant reads it, in the dashboard language. */
export function useCustomFieldProblemText() {
  const t = useMessages(customFieldMessages);
  return (field: CustomFieldEntry, problem: DraftProblem): string => {
    const typeLabel = t(`type.${customFieldItemType(field.definition.type)}` as CustomFieldMessageKey);
    const code = `issue.${problem.issue.code}` as CustomFieldMessageKey;
    const message = t(code in customFieldMessages.en ? code : "issue.invalid", {
      type: typeLabel,
      limit: problem.issue.limit ?? "",
    });
    return problem.issue.index === undefined ? message : t("itemIssue", { index: problem.issue.index + 1, message });
  };
}

interface EditorProps {
  ownerType: CustomFieldOwnerType;
  ownerId: string;
  canEdit: boolean;
}

/**
 * The fields of one owner, registered with the nearest save scope. Without
 * one it renders its own Save and Discard under the fields.
 */
export function CustomFieldsEditor({ ownerType, ownerId, canEdit }: EditorProps) {
  const t = useMessages(customFieldMessages);
  const queryClient = useQueryClient();
  const currency = useCurrency();
  const currencyCode = currency.code ?? DEFAULT_CURRENCY.code;
  const priceIncrementMinor = resolvePriceIncrementMinor(currencyCode, currency.priceIncrementMinor);
  // Money values are checked against the store's price increment, as the server does.
  const context = useMemo<CustomFieldCodecContext>(
    () => ({ decimalPlaces: getDecimalPlaces(currencyCode), currencyCode, priceIncrementMinor }),
    [currencyCode, priceIncrementMinor],
  );
  const problemText = useCustomFieldProblemText();
  const { data, isError, refetch } = useQuery(customFieldValuesQueryOptions(ownerType, ownerId));
  const fields = data?.fields;
  const [saved, setSaved] = useState<Drafts>({});
  const [drafts, setDrafts] = useState<Drafts>({});
  const [serverProblems, setServerProblems] = useState<Record<string, string>>({});
  const [ownSaving, setOwnSaving] = useState(false);
  const [ownError, setOwnError] = useState<string | null>(null);
  const sentRef = useRef<string[]>([]);

  const changedIds = (fields ?? [])
    .filter((field) => writable(field) && !sameDraft(drafts[field.definition.id] ?? "", saved[field.definition.id] ?? ""))
    .map((field) => field.definition.id);
  const dirty = canEdit && changedIds.length > 0;

  useEffect(() => {
    if (!fields || dirty) return;
    const loaded = draftsOf(fields);
    setSaved(loaded);
    setDrafts(loaded);
    // A fresh read replaces the drafts only while they have no edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields]);

  const problems = useMemo(() => {
    const found: Record<string, string> = {};
    for (const field of fields ?? []) {
      if (!changedIds.includes(field.definition.id)) continue;
      const problem = checkDraft(field.definition, drafts[field.definition.id] ?? "", context);
      if (problem) found[field.definition.id] = problemText(field, problem);
    }
    return found;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, drafts, saved, context]);

  const applySaved = (result: CustomFieldOwnerValues) => {
    queryClient.setQueryData(customFieldValuesQueryOptions(ownerType, ownerId).queryKey, result);
    const next = draftsOf(result.fields);
    setSaved(next);
    setDrafts(next);
    setServerProblems({});
  };

  const save = async () => {
    if (!fields) return;
    if (Object.keys(problems).length > 0) throw new SaveNotCompleted(t("cardSaveFailed"), Object.values(problems));
    const values = changedIds.map((id) => {
      const field = fields.find((entry) => entry.definition.id === id)!;
      return { definitionId: id, value: valueFromDraft(field.definition.type, drafts[id] ?? "", context)?.value ?? null };
    });
    sentRef.current = values.map((value) => value.definitionId);
    try {
      applySaved(await saveCustomFieldValues(ownerType, ownerId, values));
    } catch (error) {
      if (isAdminApiConflictError(error)) throw new SaveConflict(t("cardConflict"));
      const issues = error instanceof AdminApiResponseError
        ? (error.details as { issues?: Array<{ path?: unknown[]; code?: string; limit?: string | number }> } | undefined)?.issues
        : undefined;
      if (issues?.length) {
        const found: Record<string, string> = {};
        for (const issue of issues) {
          const id = typeof issue.path?.[1] === "number" ? sentRef.current[issue.path[1]] : undefined;
          const field = fields.find((entry) => entry.definition.id === id);
          if (!field || !issue.code) continue;
          const index = typeof issue.path?.[3] === "number" ? issue.path[3] : undefined;
          found[field.definition.id] = problemText(field, { issue: { code: issue.code as never, limit: issue.limit, ...(index === undefined ? {} : { index }) } });
        }
        setServerProblems(found);
        throw new SaveNotCompleted(t("cardSaveFailed"), Object.values(found).length ? Object.values(found) : [getServerFnError(error, t("cardSaveFailed"))]);
      }
      throw error;
    }
  };
  const discard = () => {
    setDrafts(saved);
    setServerProblems({});
    setOwnError(null);
  };

  const inScope = useSaveBar({
    label: t("cardTitle"),
    dirty,
    invalid: Object.keys(problems).length > 0,
    save,
    discard,
    reload: async () => {
      const latest = await refetch();
      if (latest.data) setSaved(draftsOf(latest.data.fields));
    },
  });

  if (isError) {
    return (
      <InlineError title={t("loadFailed")} onRetry={() => void refetch()} />
    );
  }
  if (!fields) return <Skeleton className="h-16 w-full" />;
  if (fields.length === 0) {
    return <p className="text-body text-muted-foreground">{t("cardEmpty", { owner: t(`ownerOne.${ownerType}` as CustomFieldMessageKey) })}</p>;
  }

  const saveOwn = async () => {
    setOwnSaving(true);
    setOwnError(null);
    try {
      await save();
      toast.success(t("savedToast"));
    } catch (error) {
      setOwnError(error instanceof SaveNotCompleted ? error.message : getServerFnError(error, t("cardSaveFailed")));
    } finally {
      setOwnSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {fields.map((field) => {
        const { definition } = field;
        const id = `custom-field-${definition.id}`;
        const editable = canEdit && writable(field);
        const typeLabel = t(`type.${customFieldItemType(definition.type)}` as CustomFieldMessageKey);
        const label = <>
          {definition.name}
          <span className="sr-only"> ({isCustomFieldListType(definition.type) ? t("listOf", { type: typeLabel }) : typeLabel})</span>
        </>;
        if (!editable) return (
          <SavedCustomFieldValue
            key={definition.id}
            field={field}
            label={label}
            help={definition.namespace !== "custom" ? t("managedBy", { namespace: definition.namespace }) : definition.description}
          />
        );
        const problem = serverProblems[definition.id] ?? problems[definition.id];
        const note = problem
          ?? definition.description
          ?? (customFieldItemType(definition.type) === "json" ? t("jsonHelp", { example: "{\"size\": \"M\"}" }) : null)
          ?? (customFieldItemType(definition.type) === "date_time" ? t("dateTimeHelp") : null);
        return (
          <Field
            key={definition.id}
            id={id}
            noteId={`${id}-note`}
            label={label}
            help={problem ? undefined : note}
            error={problem}
          >
            <CustomFieldInput
              id={id}
              type={definition.type}
              validations={definition.validations}
              draft={drafts[definition.id] ?? (isCustomFieldListType(definition.type) ? [] : "")}
              onChange={(draft) => {
                setDrafts((current) => ({ ...current, [definition.id]: draft }));
                setServerProblems((current) => {
                  if (!(definition.id in current)) return current;
                  const { [definition.id]: _cleared, ...rest } = current;
                  return rest;
                });
              }}
              invalid={Boolean(problem)}
              describedBy={note ? `${id}-note` : undefined}
              label={definition.name}
            />
          </Field>
        );
      })}
      {!inScope && dirty ? (
        <div className="space-y-2 border-t pt-4">
          {ownError ? <p role="alert" className="text-body text-destructive">{ownError}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={ownSaving} onClick={discard}>{t("discard")}</Button>
            <Button type="button" loading={ownSaving} onClick={() => void saveOwn()}>{t("saveCard")}</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The Custom data card for an editor's side column. */
export function CustomFieldsCard({ ownerType, ownerId, canEdit }: EditorProps) {
  const t = useMessages(customFieldMessages);
  const canManage = usePermissions().hasPermission(PERMISSIONS.SETTINGS_GENERAL_VIEW);
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>{t("cardTitle")}</CardTitle>
        {canManage ? (
          <Button asChild variant="link" size="sm">
            <Link to="/admin/settings/custom-data">{t("manageFields")}</Link>
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        <CustomFieldsEditor ownerType={ownerType} ownerId={ownerId} canEdit={canEdit} />
      </CardContent>
    </Card>
  );
}

/**
 * The Custom data of one saved SKU in a dialog with its own Save, for the
 * product editor's variant rows (whose detail panel unmounts when it closes).
 */
export function VariantCustomFieldsDialog({ variantId, sku, canEdit, open, onOpenChange }: {
  variantId: string | null;
  sku: string;
  canEdit: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useMessages(customFieldMessages);
  const bar = useMessages(saveBarMessages);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const close = (state: SaveScopeState) => {
    state.discardAll();
    setConfirmDiscard(false);
    onOpenChange(false);
  };
  const requestClose = (state: SaveScopeState) => {
    if (state.busy) return;
    if (state.dirty) setConfirmDiscard(true);
    else close(state);
  };
  return (
    <SaveScope
      savedMessage={t("savedToast")}
      render={(state) => (
        <>
          <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose(state))}>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>{t("variantTitle", { sku })}</DialogTitle>
                <DialogDescription className="sr-only">{t("description")}</DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <SaveErrorBanner />
                {variantId ? <CustomFieldsEditor ownerType="variant" ownerId={variantId} canEdit={canEdit} /> : null}
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" disabled={state.busy} onClick={() => requestClose(state)}>{t("cancel")}</Button>
                {canEdit ? <Button
                  type="button"
                  loading={state.busy}
                  disabled={!state.dirty}
                  onClick={async () => {
                    if (await state.saveAll()) onOpenChange(false);
                  }}
                >
                  {t("save")}
                </Button> : null}
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <ConfirmDialog
            open={confirmDiscard && state.dirty}
            onOpenChange={setConfirmDiscard}
            title={bar("discardTitle")}
            description={bar("discardDescription")}
            cancelLabel={bar("continueEditing")}
            confirmLabel={bar("discardChanges")}
            onConfirm={() => close(state)}
          />
        </>
      )}
    >
      {null}
    </SaveScope>
  );
}
