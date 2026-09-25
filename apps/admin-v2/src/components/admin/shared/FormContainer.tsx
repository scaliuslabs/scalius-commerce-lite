import type React from "react";
import type { UseFormReturn, FieldValues } from "react-hook-form";
import { Form } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { ErrorBoundary } from "@/components/admin/ErrorBoundary";
import { PageHeader } from "@/components/admin/resource/PageHeader";
import { useMessages } from "~/i18n";
import { saveBarMessages } from "~/i18n/save-bar";
import { ReadOnlyNotice } from "@/components/admin/resource/ReadOnlyNotice";
import { SaveBarProvider, SaveErrorBanner, useSaveScope } from "./SaveBar";
import { useFormSaveBar } from "./use-form-save-bar";

interface FormContainerProps<
  TFieldValues extends FieldValues,
  TTransformedValues extends FieldValues = TFieldValues,
> {
  /** Page title: the record's name, or "Add …" for a new one. */
  heading: React.ReactNode;
  /** Status badge next to the title. */
  badge?: React.ReactNode;
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
  children,
}: {
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
  const t = useMessages(saveBarMessages);
  useFormSaveBar({ form, saving, locked: !canSave, save, savedValues, reload });
  const scope = useSaveScope();
  return (
    <form
      method="post"
      noValidate
      className={className}
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
        {canSave ? (
          // Shopify repeats Save at the end of the page, under a divider.
          <div className="flex justify-end border-t pt-4">
            <Button type="submit" loading={Boolean(scope?.busy)} disabled={!scope?.dirty}>
              {t("save")}
            </Button>
          </div>
        ) : null}
      </div>
    </form>
  );
}

/**
 * A record editor page: title with a back arrow, then the cards, then Save.
 * Edits also show the contextual save bar, which saves, discards and guards
 * leaving the page; a failed save is explained in a banner under the title.
 */
export function FormContainer<
  TFieldValues extends FieldValues,
  TTransformedValues extends FieldValues = TFieldValues,
>({
  heading,
  badge,
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
}: FormContainerProps<TFieldValues, TTransformedValues>) {
  return (
    <ErrorBoundary>
      <SaveBarProvider unsavedLabel={unsavedLabel} savedMessage={savedMessage}>
        <Form {...form}>
          <EditorForm
            form={form}
            saving={isSubmitting}
            canSave={canSave}
            save={onSave}
            savedValues={savedValues}
            reload={reload}
            className={formClassName}
            header={<PageHeader backTo={backUrl} badge={badge} title={heading} />}
            readOnlyNotice={readOnlyNotice}
          >
            {children}
          </EditorForm>
        </Form>
      </SaveBarProvider>
    </ErrorBoundary>
  );
}
