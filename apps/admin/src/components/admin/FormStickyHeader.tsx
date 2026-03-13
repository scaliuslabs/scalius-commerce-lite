import { Button } from "@/components/ui/button";
import { Loader2, ArrowLeft, ChevronRight, Plus } from "lucide-react";

interface FormStickyHeaderProps {
  /** The section name shown as breadcrumb link (e.g., "Categories") */
  title: string;
  /** The entity name (e.g., category name being edited). Falls back to "New"/"Edit" */
  entityName?: string;
  isEdit: boolean;
  isSubmitting: boolean;
  isDirty?: boolean;
  /** URL to navigate back to (e.g., "/admin/categories") */
  cancelUrl: string;
  /** URL for "New X" button shown in edit mode (e.g., "/admin/categories/new") */
  newUrl?: string;
  /** Label for the "New X" button (e.g., "New Category") */
  newLabel?: string;
  /** Custom save button label. Defaults to "Save {title}" / "Create {title}" */
  saveLabel?: string;
  onSave: () => void;
}

export function FormStickyHeader({
  title,
  entityName,
  isEdit,
  isSubmitting,
  isDirty = false,
  cancelUrl,
  newUrl,
  newLabel,
  saveLabel,
  onSave,
}: FormStickyHeaderProps) {
  const defaultSaveLabel = isSubmitting
    ? "Saving..."
    : isEdit
      ? saveLabel || `Save ${title.replace(/s$/, "")}`
      : saveLabel || `Create ${title.replace(/s$/, "")}`;

  return (
    <div className="sticky top-0 z-50 border-b bg-background -mt-6">
      <div className="container flex h-12 items-center justify-between gap-4 px-4 sm:px-6">
        {/* Left side - Breadcrumbs */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Button variant="ghost" size="icon" asChild className="h-7 w-7">
            <a href={cancelUrl}>
              <ArrowLeft className="h-3.5 w-3.5" />
              <span className="sr-only">Back to {title.toLowerCase()}</span>
            </a>
          </Button>
          <nav className="flex items-center gap-1 text-sm min-w-0">
            <a
              href={cancelUrl}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              {title}
            </a>
            <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="font-medium truncate">
              {entityName || (isEdit ? "Edit" : "New")}
            </span>
            {isDirty && (
              <span className="ml-2 text-xs text-amber-600 dark:text-amber-500 shrink-0">
                • Unsaved
              </span>
            )}
          </nav>
        </div>

        {/* Right side - Action buttons */}
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            type="button"
            asChild
            disabled={isSubmitting}
            className="h-8 text-xs hidden sm:inline-flex"
          >
            <a href={cancelUrl}>Discard</a>
          </Button>

          {isEdit && newUrl && (
            <Button
              variant="outline"
              size="sm"
              asChild
              className="h-8 text-xs hidden sm:inline-flex gap-1"
            >
              <a href={newUrl}>
                <Plus className="h-3.5 w-3.5" />
                {newLabel || `New ${title.replace(/s$/, "")}`}
              </a>
            </Button>
          )}
          <Button
            size="sm"
            type="button"
            disabled={isSubmitting}
            onClick={onSave}
            className="h-8 text-xs font-medium"
          >
            {isSubmitting && (
              <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
            )}
            {defaultSaveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
