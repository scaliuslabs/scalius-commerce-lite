import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Loader2, Plus } from "lucide-react";
import { Link } from "@tanstack/react-router";

export interface FormActionBarProps {
  title: string;
  isEdit: boolean;
  isSubmitting: boolean;
  isDirty?: boolean;
  cancelUrl: string;
  newUrl?: string;
  newLabel?: string;
  saveLabel?: string;
  onSave: () => void;
}

/**
 * Form action bar rendered via portal into the layout's bottom slot.
 * Sits OUTSIDE the scroll container — always at the true bottom edge.
 */
export function FormActionBar({
  title,
  isEdit,
  isSubmitting,
  isDirty = false,
  cancelUrl,
  newUrl,
  newLabel,
  saveLabel,
  onSave,
}: FormActionBarProps) {
  const defaultSaveLabel = isSubmitting
    ? "Saving..."
    : isEdit
      ? saveLabel || `Save ${title.replace(/s$/, "")}`
      : saveLabel || `Create ${title.replace(/s$/, "")}`;

  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setPortalTarget(document.getElementById("form-action-bar-slot"));
  }, []);

  const bar = (
    <div className="border-t bg-background">
      <div className="flex h-12 items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-2 text-sm min-w-0">
          {isDirty && (
            <span className="text-xs text-amber-600 dark:text-amber-500 font-medium">
              Unsaved changes
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            type="button"
            asChild
            disabled={isSubmitting}
            className="h-8 text-xs"
          >
            <Link to={cancelUrl}>Discard</Link>
          </Button>

          {isEdit && newUrl && (
            <Button
              variant="outline"
              size="sm"
              asChild
              className="h-8 text-xs hidden sm:inline-flex gap-1"
            >
              <Link to={newUrl!}>
                <Plus className="h-3.5 w-3.5" />
                {newLabel || `New ${title.replace(/s$/, "")}`}
              </Link>
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

  if (portalTarget) {
    return createPortal(bar, portalTarget);
  }

  // Fallback if portal target not found (shouldn't happen in admin layout)
  return bar;
}

// Legacy export — kept for backwards compatibility
export type FormStickyHeaderProps = FormActionBarProps & {
  entityName?: string;
};

export function FormStickyHeader(props: FormStickyHeaderProps) {
  return <FormActionBar {...props} />;
}

// No-op — breadcrumb removed (topbar handles navigation)
export function FormBreadcrumb() {
  return null;
}
