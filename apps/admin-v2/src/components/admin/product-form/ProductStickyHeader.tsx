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

export function ProductBreadcrumb({
  productName,
  isEdit,
  cancelUrl = "/admin/products",
}: Pick<ProductStickyHeaderProps, "productName" | "isEdit" | "cancelUrl">) {
  return (
    <div className="flex items-center gap-2 mb-4">
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
      </nav>
    </div>
  );
}

export function ProductActionBar({
  isEdit,
  isSubmitting,
  isDirty = false,
  cancelUrl = "/admin/products",
  onSave,
}: Omit<ProductStickyHeaderProps, "productName">) {
  return (
    <div className="sticky bottom-0 z-30 border-t bg-background/95 backdrop-blur-sm -mx-3 sm:-mx-4 md:-mx-6 mt-4">
      <div className="flex h-14 items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-2 text-sm min-w-0">
          {isDirty && (
            <span className="text-xs text-amber-600 dark:text-amber-500">
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
}

// Legacy combined component
export function ProductStickyHeader(props: ProductStickyHeaderProps) {
  return (
    <>
      <ProductBreadcrumb
        productName={props.productName}
        isEdit={props.isEdit}
        cancelUrl={props.cancelUrl}
      />
      <ProductActionBar
        isEdit={props.isEdit}
        isSubmitting={props.isSubmitting}
        isDirty={props.isDirty}
        cancelUrl={props.cancelUrl}
        onSave={props.onSave}
      />
    </>
  );
}
