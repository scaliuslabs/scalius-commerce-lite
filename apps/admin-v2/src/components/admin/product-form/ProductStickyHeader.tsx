// src/components/admin/product-form/ProductStickyHeader.tsx
import { Button } from "@/components/ui/button";
import { Loader2, ArrowLeft, ChevronRight, Plus } from "lucide-react";
import { Link } from "@tanstack/react-router";


interface ProductStickyHeaderProps {
  productName: string;
  isEdit: boolean;
  isSubmitting: boolean;
  isDirty?: boolean;
  cancelUrl?: string;
  onSave?: () => void;
}

export function ProductStickyHeader({
  productName,
  isEdit,
  isSubmitting,
  isDirty = false,
  cancelUrl = "/admin/products",
  onSave,
}: ProductStickyHeaderProps) {
  return (
    <div className="sticky top-0 z-30 border-b bg-background -mt-3 sm:-mt-4 md:-mt-6 -mx-3 sm:-mx-4 md:-mx-6">
      <div className="flex h-12 items-center justify-between gap-4 px-4 sm:px-6">
        {/* Left side - Breadcrumbs */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Button variant="ghost" size="icon" asChild className="h-7 w-7">
            <Link to={cancelUrl}>
              <ArrowLeft className="h-3.5 w-3.5" />
              <span className="sr-only">Back to products</span>
            </Link>
          </Button>
          <nav className="flex items-center gap-1 text-sm min-w-0">
            <Link
              to={cancelUrl}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              Products
            </Link>
            <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="font-medium truncate">
              {productName || (isEdit ? "Edit" : "New")}
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
}
