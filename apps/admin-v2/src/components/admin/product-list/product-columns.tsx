import { Link } from "@tanstack/react-router";
import { Copy, Image as ImageIcon } from "lucide-react";
import { toast } from "sonner";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { Badge } from "~/components/ui/badge";
import type { ColumnDef } from "~/components/admin/data-table/table-config";
import type { ExtraAction } from "~/components/admin/data-table/DataTableRowActions";
import { createActionsColumn, createSelectColumn } from "~/components/admin/data-table/columns/column-factories";
import { translate } from "~/i18n";
import { productMessages, type ProductMessageKey } from "~/i18n/products";
import type { ProductListItemDto } from "~/lib/api-query-options/products";

export type ProductListItem = ProductListItemDto;

// Cells render inside the page, which re-renders when the dashboard language changes.
const t = (key: ProductMessageKey, vars?: Record<string, string | number>) =>
  translate(productMessages, key, vars);

export function productShortcodeAction(slug: string): ExtraAction {
  return {
    label: t("copyShortcode"),
    icon: Copy,
    onClick: () => {
      navigator.clipboard
        .writeText(`[product slug="${slug}"]`)
        .then(() => toast.success(t("shortcodeCopied")))
        .catch(() => toast.error(t("shortcodeCopyFailed")));
    },
  };
}

export function ProductThumb({ src }: { src: string | null }) {
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted">
      {src ? (
        <img
          src={mediaImageUrl(src, 96)}
          alt=""
          className="h-full w-full object-contain object-center"
          loading="lazy"
          decoding="async"
        />
      ) : (
        <ImageIcon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      )}
    </div>
  );
}

export function ProductStatusBadge({ isActive }: { isActive: boolean }) {
  return (
    <Badge variant={isActive ? "success" : "attention"} className="shrink-0">
      {t(isActive ? "statusActive" : "statusDraft")}
    </Badge>
  );
}

export function ProductTitleLink({ product }: { product: ProductListItem }) {
  return (
    <Link
      to="/admin/products/$productId/edit"
      params={{ productId: product.id }}
      className="truncate text-body font-medium text-foreground hover:underline"
    >
      {product.name || t("untitled")}
    </Link>
  );
}

interface ProductColumnOptions {
  showTrashed: boolean;
  fmt: (price: number) => string;
  canSelect: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canRestore: boolean;
  canPermanentDelete: boolean;
  onOpen: (product: ProductListItem) => void;
  onDelete: (product: ProductListItem) => void;
  onRestore: (product: ProductListItem) => void;
  onPermanentDelete: (product: ProductListItem) => void;
}

export function getProductColumns(opts: ProductColumnOptions): ColumnDef<ProductListItem, unknown>[] {
  return [
    ...(opts.canSelect
      ? [createSelectColumn<ProductListItem>({ getLabel: (row) => (row as ProductListItem).name })]
      : []),
    {
      id: "product",
      header: () => t("columnProduct"),
      cell: ({ row }) => (
        <div className="flex min-w-0 items-center gap-3">
          <ProductThumb src={row.original.primaryImage} />
          <ProductTitleLink product={row.original} />
        </div>
      ),
      enableSorting: false,
    },
    {
      id: "status",
      header: () => t("columnStatus"),
      cell: ({ row }) => <ProductStatusBadge isActive={row.original.isActive} />,
      enableSorting: false,
      size: 100,
    },
    {
      id: "variants",
      header: () => t("columnVariants"),
      cell: ({ row }) => (
        <span className="text-body text-muted-foreground">
          {row.original.variantCount > 1 ? t("variantCount", { count: row.original.variantCount }) : "—"}
        </span>
      ),
      enableSorting: false,
      size: 110,
    },
    {
      id: "category",
      header: () => t("columnCategory"),
      cell: ({ row }) => (
        <span className="text-body text-muted-foreground">
          {row.original.category.name || t("uncategorized")}
        </span>
      ),
      enableSorting: false,
      size: 160,
    },
    {
      id: "price",
      header: () => <div className="text-right">{t("columnPrice")}</div>,
      cell: ({ row }) => <div className="text-right text-body tabular-nums">{opts.fmt(row.original.price)}</div>,
      enableSorting: false,
      size: 120,
    },
    createActionsColumn<ProductListItem>({
      showTrashed: opts.showTrashed,
      onView: opts.canEdit ? undefined : opts.onOpen,
      onEdit: opts.canEdit ? opts.onOpen : undefined,
      onDelete: opts.canDelete ? opts.onDelete : undefined,
      onRestore: opts.canRestore ? opts.onRestore : undefined,
      onPermanentDelete: opts.canPermanentDelete ? opts.onPermanentDelete : undefined,
      getExtraActions: (product) => (opts.showTrashed ? undefined : [productShortcodeAction(product.slug)]),
    }),
  ];
}
