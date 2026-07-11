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
  /** Whether the edit form may offer a shortcut to create another entity. */
  canCreateNew?: boolean;
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
  canCreateNew = true,
  saveLabel,
  form,
  onSubmit,
  children,
  formClassName = "-mt-4 pb-6",
}: FormContainerProps<T>) {
  const entityLabel = newLabel?.replace(/^New\s+/, "") ?? title.replace(/s$/, "");

  return (
    <ErrorBoundary>
      <Form {...form}>
        <UnsavedChangesGuard
          isDirty={form.formState.isDirty}
          isSubmitting={isSubmitting}
        />
        <form
          method="post"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
          className={formClassName}
          noValidate
        >
          <div className="mb-4">
            <h1 className="text-xl font-semibold tracking-tight">
              {isEdit ? `Edit ${entityLabel}` : `Create ${entityLabel}`}
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">
              {isEdit
                ? `Update this ${entityLabel.toLowerCase()} and save when ready.`
                : `Add a new ${entityLabel.toLowerCase()} to your store.`}
            </p>
          </div>
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
          canCreateNew={canCreateNew}
          saveLabel={saveLabel}
          onSave={onSubmit}
        />
      </Form>
    </ErrorBoundary>
  );
}
