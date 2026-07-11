import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Loader2, Plus } from "lucide-react";
import { Link } from "@tanstack/react-router";

interface ProductStickyHeaderProps {
  productName: string;
  isEdit: boolean;
  isSubmitting: boolean;
  isDirty?: boolean;
  cancelUrl?: string;
  onSave?: () => void;
}

export function ProductActionBar({
  isEdit,
  isSubmitting,
  isDirty = false,
  cancelUrl = "/admin/products",
  onSave,
}: Omit<ProductStickyHeaderProps, "productName">) {
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

          {isEdit && (
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
            {isSubmitting
              ? "Saving..."
              : isEdit
                ? "Save Product"
                : "Create Product"}
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

// Legacy combined component
export function ProductStickyHeader(props: ProductStickyHeaderProps) {
  return (
    <ProductActionBar
      isEdit={props.isEdit}
      isSubmitting={props.isSubmitting}
      isDirty={props.isDirty}
      cancelUrl={props.cancelUrl}
      onSave={props.onSave}
    />
  );
}

// No-op — breadcrumb removed (topbar handles navigation)
export function ProductBreadcrumb() {
  return null;
}
