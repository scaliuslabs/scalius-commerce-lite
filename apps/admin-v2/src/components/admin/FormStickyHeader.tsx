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
  canCreateNew?: boolean;
  /**
   * Whether the current operator may submit this form. This is required so a
   * direct form URL cannot accidentally render an enabled save action. API
   * authorization remains the final enforcement boundary.
   */
  canSave: boolean;
  /** Optional explanation exposed on a disabled save action. */
  saveDisabledReason?: string;
  saveLabel?: string;
  onDiscard?: () => void;
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
  canCreateNew = true,
  canSave,
  saveDisabledReason,
  saveLabel,
  onDiscard,
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
          {isSubmitting ? (
            <Button
              variant="outline"
              size="sm"
              type="button"
              disabled
              className="h-8 text-xs"
            >
              Discard
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              type="button"
              asChild
              className="h-8 text-xs"
            >
              <Link to={cancelUrl} onClick={onDiscard}>Discard</Link>
            </Button>
          )}

          {isEdit && canCreateNew && newUrl && (
            isSubmitting ? (
              <Button
                variant="outline"
                size="sm"
                type="button"
                disabled
                className="h-8 text-xs hidden sm:inline-flex gap-1"
              >
                <Plus className="h-3.5 w-3.5" />
                {newLabel || `New ${title.replace(/s$/, "")}`}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                asChild
                className="h-8 text-xs hidden sm:inline-flex gap-1"
              >
                <Link to={newUrl}>
                  <Plus className="h-3.5 w-3.5" />
                  {newLabel || `New ${title.replace(/s$/, "")}`}
                </Link>
              </Button>
            )
          )}
          <Button
            size="sm"
            type="button"
            disabled={isSubmitting || !canSave || !isDirty}
            title={!canSave
              ? saveDisabledReason ?? `You do not have permission to save this ${title.replace(/s$/, "").toLowerCase()}.`
              : !isDirty
                ? "No changes to save"
              : undefined}
            onClick={() => {
              if (canSave && isDirty) onSave();
            }}
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
