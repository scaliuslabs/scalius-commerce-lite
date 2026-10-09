import type React from "react";
import type { UseFormReturn, FieldValues } from "react-hook-form";
import { Form } from "@/components/ui/form";
import { ErrorBoundary } from "@/components/admin/ErrorBoundary";
import { PageHeader } from "@/components/admin/resource/PageHeader";
import { Page } from "@/components/admin/resource/Page";
import { ReadOnlyNotice } from "@/components/admin/resource/ReadOnlyNotice";
import { SaveBarProvider, SaveErrorBanner, useSaveScope } from "./SaveBar";
import { useFormSaveBar } from "./use-form-save-bar";
import { EditorPresenceProvider, PresenceNotices, PresenceSlot, announceSave, changedFieldNames } from "~/lib/realtime/store";

interface FormContainerProps<
  TFieldValues extends FieldValues,
  TTransformedValues extends FieldValues = TFieldValues,
> {
  /** Page title: the record's name, or "Add …" for a new one. */
  heading: React.ReactNode;
  /** Status badge next to the title. */
  badge?: React.ReactNode;
  /** Header actions on the right (apps' "More actions"); they never submit the form. */
  actions?: React.ReactNode;
  /** The list this record belongs to, for the back arrow. */
  backUrl: string;
  isSubmitting: boolean;
  /**
   * Fail-closed save capability for direct form URLs. Required so every
   * consumer deliberately maps its create/edit API permission.
   */
  canSave: boolean;
  form: UseFormReturn<TFieldValues, unknown, TTransformedValues>;
  /** Saves valid values; throws when the save failed (after marking any fields). */
  onSave: (values: TTransformedValues) => Promise<unknown>;
  /** Fields the server set on save (new id, next revision), from what `onSave` resolved with. */
  savedValues?: (result: unknown) => Partial<TFieldValues>;
  /** After a revision conflict: loads the latest saved record and keeps the merchant's edits. */
  reload?: () => Promise<unknown>;
  children: React.ReactNode;
  formClassName?: string;
  /** Save bar text while creating, e.g. "Unsaved category" (Shopify names the new record). */
  unsavedLabel?: string;
  /** Success toast, e.g. "Category saved". */
  savedMessage?: string;
  /** Replaces the permission notice when the record is read-only for another reason (e.g. it's in Trash). */
  readOnlyNotice?: React.ReactNode;
  /**
   * The saved record's presence key (`presenceKey("category", id)`): shows who
   * else is editing it and announces this editor's saves. Null for a new record.
   */
  presenceKey?: string | null;
}

function EditorForm<TFieldValues extends FieldValues, TTransformedValues extends FieldValues>({
  form,
  saving,
  canSave,
  save,
  savedValues,
  reload,
  className,
  header,
  readOnlyNotice,
  presenceKey = null,
  children,
}: {
  presenceKey?: string | null;
  form: UseFormReturn<TFieldValues, unknown, TTransformedValues>;
  saving: boolean;
  canSave: boolean;
  save: (values: TTransformedValues) => Promise<unknown>;
  savedValues?: (result: unknown) => Partial<TFieldValues>;
  reload?: () => Promise<unknown>;
  className: string;
  header: React.ReactNode;
  readOnlyNotice?: React.ReactNode;
  children: React.ReactNode;
}) {
  // A save tells the other editors on this record at once (realtime presence).
  const announcingSave = async (values: TTransformedValues) => {
    const changed = changedFieldNames(form.formState.dirtyFields);
    const result = await save(values);
    if (presenceKey) {
      const revision = (savedValues?.(result) as { revision?: unknown } | undefined)?.revision;
      announceSave(presenceKey, typeof revision === "number" ? revision : null, changed);
    }
    return result;
  };
  useFormSaveBar({ form, saving, locked: !canSave, save: announcingSave, savedValues, reload });
  const scope = useSaveScope();
  // Read while rendering, so react-hook-form keeps the tree current for the presence calls.
  void form.formState.dirtyFields;
  const loadedRevision = (form.formState.defaultValues as { revision?: unknown } | undefined)?.revision;
  return (
    <EditorPresenceProvider
      presenceKey={presenceKey}
      revision={typeof loadedRevision === "number" ? loadedRevision : null}
      dirty={Boolean(scope?.dirty)}
      changedFields={() => changedFieldNames(form.formState.dirtyFields)}
      onLoadLatest={reload ? () => void reload() : undefined}
    >
    <form
      method="post"
      noValidate
      className={className}
      data-presence-root={presenceKey ?? undefined}
      onSubmit={(event) => {
        event.preventDefault();
        // React bubbles submits from forms in portalled dialogs; only this form saves the page.
        if (event.target === event.currentTarget && scope?.dirty && !scope.busy) void scope.saveAll();
      }}
    >
      {header}
      {/* A flex gap, so the banner's hidden placeholder adds no space. */}
      <div className="flex flex-col gap-4">
        <SaveErrorBanner />
        {canSave ? null : readOnlyNotice ?? <ReadOnlyNotice />}
        {/* Without the save permission the record opens read-only. */}
        <fieldset disabled={!canSave} className="min-w-0">
          {children}
        </fieldset>
      </div>
      <PresenceNotices />
    </form>
    </EditorPresenceProvider>
  );
}

/**
 * A record editor page: title with a back arrow, then the cards. Save lives
 * only in the contextual save bar (and Cmd/Ctrl+S, P4), which saves, discards
 * and guards leaving the page; a failed save is explained in a banner under the title.
 */
export function FormContainer<
  TFieldValues extends FieldValues,
  TTransformedValues extends FieldValues = TFieldValues,
>({
  heading,
  badge,
  actions,
  backUrl,
  isSubmitting,
  canSave,
  form,
  onSave,
  savedValues,
  reload,
  children,
  formClassName = "pb-6",
  unsavedLabel,
  savedMessage,
  readOnlyNotice,
  presenceKey,
}: FormContainerProps<TFieldValues, TTransformedValues>) {
  return (
    <ErrorBoundary>
      <SaveBarProvider unsavedLabel={unsavedLabel} savedMessage={savedMessage}>
        <Form {...form}>
          <Page width="form">
          <EditorForm
            form={form}
            saving={isSubmitting}
            canSave={canSave}
            save={onSave}
            savedValues={savedValues}
            reload={reload}
            className={formClassName}
            header={<PageHeader backTo={backUrl} status={badge} presence={<PresenceSlot />} title={heading} actions={actions} />}
            readOnlyNotice={readOnlyNotice}
            presenceKey={presenceKey}
          >
            {children}
          </EditorForm>
          </Page>
        </Form>
      </SaveBarProvider>
    </ErrorBoundary>
  );
}
