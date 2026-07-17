import { Link } from "@tanstack/react-router";
import { Image as ImageIcon, Copy } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "~/components/ui/badge";
import { Checkbox } from "~/components/ui/checkbox";
import { DataTableRowActions } from "~/components/admin/data-table/DataTableRowActions";
import type { ProductListItem } from "~/components/admin/data-table/columns/product-columns";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import { formatDateShort } from "@scalius/shared/timestamps";

interface ProductMobileRowProps {
  product: ProductListItem;
  selected: boolean;
  showTrashed: boolean;
  canSelect: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canRestore: boolean;
  canPermanentDelete: boolean;
  formatPrice: (price: number) => string;
  onSelectedChange: (selected: boolean) => void;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onPermanentDelete: () => void;
}

function copyShortcode(slug: string) {
  navigator.clipboard.writeText(`[product slug="${slug}"]`)
    .then(() => toast.success("Product shortcode copied."))
    .catch(() => toast.error("Could not copy the product shortcode."));
}

export function ProductMobileRow({
  product,
  selected,
  showTrashed,
  canSelect,
  canEdit,
  canDelete,
  canRestore,
  canPermanentDelete,
  formatPrice,
  onSelectedChange,
  onView,
  onEdit,
  onDelete,
  onRestore,
  onPermanentDelete,
}: ProductMobileRowProps) {
  return (
    <article className={`grid grid-cols-[auto_minmax(0,1fr)_auto] gap-2.5 px-2.5 py-2.5 ${selected ? "bg-primary/5" : "bg-background"}`}>
      <div className="flex items-start gap-2">
        {canSelect && (
          <Checkbox
            checked={selected}
            onCheckedChange={(value) => onSelectedChange(value === true)}
            aria-label={`Select ${product.name}`}
            className="mt-4"
          />
        )}
        <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted">
          {product.primaryImage ? (
            <img
              src={getOptimizedImageUrl(product.primaryImage, {
                width: 96,
                height: 96,
                quality: 75,
                fit: "contain",
              })}
              alt=""
              className="h-full w-full object-contain object-center"
              loading="lazy"
              decoding="async"
            />
          ) : (
            <ImageIcon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          )}
        </div>
      </div>

      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <Link
            to="/admin/products/$productId"
            params={{ productId: product.id }}
            className="truncate text-sm font-medium text-foreground hover:underline"
          >
            {product.name || "Unnamed product"}
          </Link>
          <Badge variant="outline" className={`h-4 shrink-0 px-1 text-[9px] ${product.isActive && !showTrashed ? "border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-400" : "text-muted-foreground"}`}>
            {showTrashed ? "Trashed" : product.isActive ? "Active" : "Draft"}
          </Badge>
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {product.sku || "No SKU"} · {product.category?.name || "Uncategorized"}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
          <span className="font-medium text-foreground">{formatPrice(product.price)}</span>
          <span className="text-muted-foreground">
            {product.variantCount} SKU{product.variantCount === 1 ? "" : "s"}
          </span>
          <span className="text-muted-foreground" suppressHydrationWarning>
            {formatDateShort(product.updatedAt)}
          </span>
        </div>
      </div>

      <DataTableRowActions
        showTrashed={showTrashed}
        menuLabel={`Open actions for ${product.name}`}
        onView={onView}
        onEdit={canEdit ? onEdit : undefined}
        onDelete={canDelete ? onDelete : undefined}
        onRestore={canRestore ? onRestore : undefined}
        onPermanentDelete={canPermanentDelete ? onPermanentDelete : undefined}
        extraActions={!showTrashed ? [{
          label: "Copy Shortcode",
          icon: Copy,
          onClick: () => copyShortcode(product.slug),
        }] : undefined}
      />
    </article>
  );
}
