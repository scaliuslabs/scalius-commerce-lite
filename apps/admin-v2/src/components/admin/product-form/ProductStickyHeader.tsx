import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Loader2, Plus } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useCatalogActionPermissions } from "@/hooks/use-catalog-action-permissions";

interface ProductActionBarProps {
  isEdit: boolean;
  isSubmitting: boolean;
  isDirty?: boolean;
  hasRevisionConflict?: boolean;
  cancelUrl?: string;
  onSave?: () => void;
}

export function ProductActionBar({
  isEdit,
  isSubmitting,
  isDirty = false,
  hasRevisionConflict = false,
  cancelUrl = "/admin/products",
  onSave,
}: ProductActionBarProps) {
  const { products: productActions } = useCatalogActionPermissions();
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setPortalTarget(document.getElementById("form-action-bar-slot"));
  }, []);

  const bar = (
    <div className="border-t bg-background">
      <div className="flex h-14 items-center justify-between gap-2 px-4 sm:h-12 sm:gap-4 sm:px-6">
        <div className="flex items-center gap-2 text-sm min-w-0">
          {hasRevisionConflict ? (
            <span className="sr-only text-xs font-medium text-amber-600 dark:text-amber-500 sm:not-sr-only">
              Out of date · Draft kept
            </span>
          ) : isDirty ? (
            <span className="sr-only text-xs font-medium text-amber-600 dark:text-amber-500 sm:not-sr-only">
              Unsaved changes
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isSubmitting ? (
            <Button
              variant="outline"
              size="sm"
              type="button"
              disabled
              className="h-11 text-xs sm:h-8"
            >
              Discard
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              type="button"
              asChild
              className="h-11 text-xs sm:h-8"
            >
              <Link to={cancelUrl}>Discard</Link>
            </Button>
          )}

          {isEdit && productActions.canCreate && (
            isSubmitting ? (
              <Button
                variant="outline"
                size="sm"
                type="button"
                disabled
                className="h-8 text-xs hidden sm:inline-flex gap-1"
              >
                <Plus className="h-3.5 w-3.5" />
                New Product
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                asChild
                className="h-8 text-xs hidden sm:inline-flex gap-1"
              >
                <Link to="/admin/products/new">
                  <Plus className="h-3.5 w-3.5" />
                  New Product
                </Link>
              </Button>
            )
          )}
          <Button
            size="sm"
            type="button"
            disabled={isSubmitting || (isEdit && !isDirty && !hasRevisionConflict)}
            onClick={onSave}
            className="h-11 text-xs font-medium sm:h-8"
          >
            {isSubmitting && (
              <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
            )}
            {isSubmitting
              ? "Saving..."
              : hasRevisionConflict
                ? "Review conflict"
              : isEdit
                ? "Save changes"
                : "Create product"}
          </Button>
        </div>
      </div>
    </div>
  );

  if (portalTarget) {
    return createPortal(bar, portalTarget);
  }

  return bar;
}
