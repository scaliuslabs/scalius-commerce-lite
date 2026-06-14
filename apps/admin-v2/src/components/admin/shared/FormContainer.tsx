import type React from "react";
import type { UseFormReturn, FieldValues } from "react-hook-form";
import { Form } from "@/components/ui/form";
import { FormActionBar } from "@/components/admin/FormStickyHeader";
import { ErrorBoundary } from "@/components/admin/ErrorBoundary";
import { UnsavedChangesGuard } from "./UnsavedChangesGuard";

interface FormContainerProps<T extends FieldValues> {
  /** The section name shown as breadcrumb link (e.g., "Categories") */
  title: string;
  /** Accepted for older form call sites; the current bottom action bar no longer displays it. */
  entityName?: string;
  isEdit: boolean;
  isSubmitting: boolean;
  /** URL to navigate back to (e.g., "/admin/categories") */
  backUrl: string;
  /** URL for "New X" button shown in edit mode (e.g., "/admin/categories/new") */
  newUrl?: string;
  /** Label for the "New X" button (e.g., "New Category") */
  newLabel?: string;
  /** Custom save button label. Defaults to "Save {title}" / "Create {title}" */
  saveLabel?: string;
  /** The react-hook-form instance — used for isDirty and to provide <Form> context */
  form: UseFormReturn<T>;
  /** Called when the save button is clicked or the form is submitted — typically `handleSubmit(onSave)` */
  onSubmit: () => void;
  /** Form field content */
  children: React.ReactNode;
  /** Additional className for the <form> element */
  formClassName?: string;
}

/**
 * Shared form layout wrapper.
 *
 * Layout: Breadcrumb (top) → Form content → Action bar (sticky bottom).
 */
export function FormContainer<T extends FieldValues>({
  title,
  isEdit,
  isSubmitting,
  backUrl,
  newUrl,
  newLabel,
  saveLabel,
  form,
  onSubmit,
  children,
  formClassName = "-mt-4 pb-6",
}: FormContainerProps<T>) {
  return (
    <ErrorBoundary>
      <Form {...form}>
        <UnsavedChangesGuard
          isDirty={form.formState.isDirty}
          isSubmitting={isSubmitting}
        />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
          className={formClassName}
        >
          {children}
        </form>
        <FormActionBar
          title={title}
          isEdit={isEdit}
          isSubmitting={isSubmitting}
          isDirty={form.formState.isDirty}
          cancelUrl={backUrl}
          newUrl={newUrl}
          newLabel={newLabel}
          saveLabel={saveLabel}
          onSave={onSubmit}
        />
      </Form>
    </ErrorBoundary>
  );
}
