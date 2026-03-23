import React from "react";
import { TableCell, TableRow } from "../../ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "../../ui/dropdown-menu";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Badge } from "../../ui/badge";
import {
  Image as ImageIcon,
  Trash2,
  Undo,
  Pencil,
  XCircle,
  Eye,
  MoreHorizontal,
  Copy,
} from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import { toast } from "sonner";
import type { ProductListItem } from "./hooks/useProductList";

interface ProductRowProps {
  product: ProductListItem;
  isSelected: boolean;
  onSelect: (id: string, checked: boolean) => void;
  onView: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onPermanentDelete: (id: string) => void;
  showTrashed: boolean;
  formatDate: (date: Date | null) => string;
  formatPrice: (price: number) => string;
}

export const ProductRow = React.memo(function ProductRow({
  product,
  isSelected,
  onSelect,
  onView,
  onEdit,
  onDelete,
  onRestore,
  onPermanentDelete,
  showTrashed,
  formatDate,
  formatPrice,
}: ProductRowProps) {
  const copyProductShortcode = (productSlug: string) => {
    const shortcode = `[product slug="${productSlug}"]`;
    navigator.clipboard
      .writeText(shortcode)
      .then(() => {
        toast.success("Product shortcode copied to clipboard!");
      })
      .catch((err) => {
        toast.error("Failed to copy shortcode.");
        console.error("Failed to copy shortcode: ", err);
      });
  };

  return (
    <TableRow
      className={cn(
        "hover:bg-muted/50 transition-colors",
        isSelected && "bg-muted",
      )}
      data-state={isSelected ? "selected" : undefined}
      data-admin-list-row=""
    >
      <TableCell className="pl-3 pr-1 py-2">
        <Checkbox
          checked={isSelected}
          onCheckedChange={(checked) => onSelect(product.id, !!checked)}
          aria-label={`Select ${product.name}`}
          className="h-3.5 w-3.5"
        />
      </TableCell>
      <TableCell className="py-2">
        <div className="h-8 w-8 overflow-hidden rounded border bg-muted flex items-center justify-center">
          {product.primaryImage ? (
            <img
              src={getOptimizedImageUrl(product.primaryImage)}
              alt={product.name}
              className="h-full w-full object-cover"
              loading="lazy"
              decoding="async"
            />
          ) : (
            <ImageIcon className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </TableCell>
      <TableCell className="py-2">
        <div
          className="font-medium text-sm text-foreground hover:underline cursor-pointer"
          onClick={() => onView(product.id)}
        >
          {product.name || "Unnamed Product"}
        </div>
        <div className="text-sm text-muted-foreground">
          SKU: {product.sku || "N/A"}
        </div>
        <div className="mt-1 flex items-center gap-1 flex-wrap">
          {product.isActive ? (
            <Badge
              variant="outline"
              className="text-xs px-1.5 py-0.5 border-green-300 bg-green-50 text-green-700 dark:border-green-700 dark:bg-green-900/30 dark:text-green-400"
            >
              Active
            </Badge>
          ) : (
            <Badge variant="outline" className="text-xs px-1.5 py-0.5">
              Inactive
            </Badge>
          )}
          {product.freeDelivery && (
            <Badge
              variant="outline"
              className="text-xs px-1.5 py-0.5 border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
            >
              Free Delivery
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell className="text-sm text-muted-foreground py-2">
        {product.category.name || "Uncategorized"}
      </TableCell>
      <TableCell className="py-2">
        <div className="font-medium text-sm text-foreground">
          {formatPrice(product.price)}
        </div>
        {product.discountType === "flat" && product.discountAmount != null && product.discountAmount > 0 ? (
          <div className="text-xs text-green-600 dark:text-green-500">
            {formatPrice(product.discountAmount)} off
          </div>
        ) : product.discountPercentage != null && product.discountPercentage > 0 ? (
          <div className="text-xs text-green-600 dark:text-green-500">
            {product.discountPercentage}% off
          </div>
        ) : null}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground py-2">
        {product.variantCount} variant{product.variantCount !== 1 ? "s" : ""}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground py-2">
        {formatDate(product.updatedAt)}
      </TableCell>
      <TableCell className="text-right pr-3 py-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7">
              <MoreHorizontal className="h-3.5 w-3.5" />
              <span className="sr-only">Product Actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[170px]">
            {showTrashed ? (
              <>
                <DropdownMenuItem onClick={() => onRestore(product.id)}>
                  <Undo className="mr-2 h-4 w-4" />
                  <span>Restore Product</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => onPermanentDelete(product.id)}
                  className="text-destructive focus:text-destructive focus:bg-destructive/10"
                >
                  <XCircle className="mr-2 h-4 w-4" />
                  <span>Delete Permanently</span>
                </DropdownMenuItem>
              </>
            ) : (
              <>
                <DropdownMenuItem onClick={() => onView(product.id)}>
                  <Eye className="mr-2 h-4 w-4" />
                  <span>View Product</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onEdit(product.id)}>
                  <Pencil className="mr-2 h-3.5 w-3.5" />
                  Edit Product
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => copyProductShortcode(product.slug)}
                >
                  <Copy className="mr-2 h-3.5 w-3.5" />
                  Copy Shortcode
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => onDelete(product.id)}
                  className="text-destructive focus:text-destructive focus:bg-destructive/10"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  <span>Move to Trash</span>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
});
