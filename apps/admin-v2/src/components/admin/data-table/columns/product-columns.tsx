import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "~/components/ui/badge";
import { Image as ImageIcon, Copy } from "lucide-react";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import { toast } from "sonner";
import { DataTableColumnHeader } from "../DataTableColumnHeader";
import { createSelectColumn, createDateColumn, createActionsColumn } from "./column-factories";

export interface ProductListItem {
  id: string;
  name: string;
  slug: string;
  price: number;
  description: string | null;
  isActive: boolean;
  discountPercentage: number | null;
  discountType: "percentage" | "flat" | null;
  discountAmount: number | null;
  freeDelivery: boolean;
  createdAt: Date;
  updatedAt: Date;
  category: {
    name: string;
  };
  variantCount: number;
  imageCount: number;
  primaryImage: string | null;
  sku?: string;
}

interface ProductColumnOptions {
  showTrashed: boolean;
  symbol: string;
  onView: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onPermanentDelete: (id: string) => void;
}

function formatPrice(price: number, symbol: string): string {
  return `${symbol}${price.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function copyProductShortcode(slug: string) {
  const shortcode = `[product slug="${slug}"]`;
  navigator.clipboard
    .writeText(shortcode)
    .then(() => {
      toast.success("Product shortcode copied to clipboard!");
    })
    .catch((err) => {
      toast.error("Failed to copy shortcode.");
      if (import.meta.env.DEV) console.error("Failed to copy shortcode: ", err);
    });
}

export function getProductColumns(
  opts: ProductColumnOptions,
): ColumnDef<ProductListItem, unknown>[] {
  return [
    createSelectColumn<ProductListItem>({ getLabel: (r) => (r as ProductListItem).name }),
    {
      id: "image",
      header: () => <span className="text-xs">Image</span>,
      cell: ({ row }) => {
        const product = row.original;
        return (
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
        );
      },
      enableSorting: false,
      size: 50,
    },
    {
      accessorKey: "name",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Product Info" />
      ),
      cell: ({ row }) => {
        const product = row.original;
        const isTrashed = opts.showTrashed;
        return (
          <div>
            <div
              className="font-medium text-sm text-foreground hover:underline cursor-pointer"
              onClick={() => opts.onView(product.id)}
            >
              {product.name || "Unnamed Product"}
            </div>
            <div className="text-sm text-muted-foreground">
              SKU: {product.sku || "N/A"}
            </div>
            <div className="mt-1 flex items-center gap-1 flex-wrap">
              {isTrashed ? (
                <Badge variant="outline" className="text-xs px-1.5 py-0.5">
                  Trashed
                </Badge>
              ) : product.isActive ? (
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
          </div>
        );
      },
    },
    {
      accessorKey: "category",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Category" />
      ),
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {row.original.category.name || "Uncategorized"}
        </span>
      ),
      size: 140,
    },
    {
      accessorKey: "price",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Price" />
      ),
      cell: ({ row }) => {
        const product = row.original;
        return (
          <div>
            <div className="font-medium text-sm text-foreground">
              {formatPrice(product.price, opts.symbol)}
            </div>
            {product.discountType === "flat" &&
            product.discountAmount != null &&
            product.discountAmount > 0 ? (
              <div className="text-xs text-green-600 dark:text-green-500">
                {formatPrice(product.discountAmount, opts.symbol)} off
              </div>
            ) : product.discountPercentage != null &&
              product.discountPercentage > 0 ? (
              <div className="text-xs text-green-600 dark:text-green-500">
                {product.discountPercentage}% off
              </div>
            ) : null}
          </div>
        );
      },
      size: 110,
    },
    {
      id: "variantCount",
      header: () => <span className="text-xs">Variants</span>,
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {row.original.variantCount} variant
          {row.original.variantCount !== 1 ? "s" : ""}
        </span>
      ),
      enableSorting: false,
      size: 80,
    },
    createDateColumn<ProductListItem>("updatedAt", "Last Updated", { size: 120 }),
    createActionsColumn<ProductListItem>({
      showTrashed: opts.showTrashed,
      onView: (p) => opts.onView(p.id),
      onEdit: (p) => opts.onEdit(p.id),
      onDelete: (p) => opts.onDelete(p.id),
      onRestore: (p) => opts.onRestore(p.id),
      onPermanentDelete: (p) => opts.onPermanentDelete(p.id),
      getExtraActions: (p) =>
        !opts.showTrashed
          ? [{ label: "Copy Shortcode", icon: Copy, onClick: () => copyProductShortcode(p.slug) }]
          : undefined,
    }),
  ];
}
