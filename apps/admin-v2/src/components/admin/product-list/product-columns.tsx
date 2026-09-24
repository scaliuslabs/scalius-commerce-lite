import { Copy, CopyPlus, Image as ImageIcon } from "lucide-react";
import { toast } from "sonner";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { cn } from "@scalius/shared/utils";
import { Badge } from "~/components/ui/badge";
import type { ColumnDef } from "~/components/admin/data-table/table-config";
import type { ExtraAction } from "~/components/admin/data-table/DataTableRowActions";
import { ResourceRowLink } from "~/components/admin/resource/ResourceListPage";
import { sortHeader } from "~/components/admin/resource/columns";
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

export function duplicateProductAction(onDuplicate: () => void): ExtraAction {
  return { label: t("duplicate"), icon: CopyPlus, onClick: onDuplicate };
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

/** "15 in stock", "62 in stock for 6 variants", or "Not tracked". */
function InventoryText({ product }: { product: ProductListItem }) {
  if (product.onHand === null) return <span className="text-muted-foreground">{t("notTracked")}</span>;
  const text = product.variantCount > 1
    ? t("inStockVariants", { count: product.onHand, variants: product.variantCount })
    : t("inStock", { count: product.onHand });
  return <span className={cn("tabular-nums", product.onHand === 0 ? "text-destructive" : "text-muted-foreground")}>{text}</span>;
}

/** Price customers pay, with the regular price struck through while a product discount runs. */
function PriceText({ product, fmt, salePrice }: {
  product: ProductListItem;
  fmt: (price: number) => string;
  salePrice: (price: number, discount: ProductListItem) => number | null;
}) {
  const sale = salePrice(product.price, product);
  return (
    <div className="tabular-nums md:text-right">
      {sale === null ? fmt(product.price) : (
        <>
          {fmt(sale)} <s className="text-muted-foreground">{fmt(product.price)}</s>
        </>
      )}
      {product.hasVariantDiscount ? <div className="text-muted-foreground">{t("saleOnSome")}</div> : null}
    </div>
  );
}

export function getProductColumns(opts: {
  trashed: boolean;
  fmt: (price: number) => string;
  salePrice: (price: number, discount: ProductListItem) => number | null;
  rowTo: (product: ProductListItem) => string | undefined;
}): ColumnDef<ProductListItem, unknown>[] {
  return [
    {
      accessorKey: "name",
      header: sortHeader(t("columnProduct")),
      meta: { mobile: "primary" },
      cell: ({ row }) => (
        <div className="flex min-w-0 items-center gap-3">
          <ProductThumb src={row.original.primaryImage} />
          <div className="min-w-0">
            <ResourceRowLink to={opts.trashed ? undefined : opts.rowTo(row.original)}>
              {row.original.name || t("untitled")}
            </ResourceRowLink>
            {/* Trash explains why "Delete permanently" isn't offered for this one. */}
            {opts.trashed && row.original.hasStockHistory ? (
              <span className="block text-muted-foreground">{t("keptForHistory")}</span>
            ) : null}
          </div>
        </div>
      ),
    },
    {
      id: "status",
      header: t("columnStatus"),
      meta: { mobile: "status" },
      cell: ({ row }) => <ProductStatusBadge isActive={row.original.isActive} />,
      enableSorting: false,
    },
    {
      id: "inventory",
      header: t("columnInventory"),
      meta: { mobile: "secondary" },
      cell: ({ row }) => <InventoryText product={row.original} />,
      enableSorting: false,
    },
    {
      id: "category",
      accessorFn: (row) => row.category.name,
      header: sortHeader(t("columnCategory")),
      meta: { mobile: "secondary" },
      // Category names wrap instead of truncating (phones show them in full).
      cell: ({ row }) => (
        <span className="break-words text-muted-foreground">{row.original.category.name || t("uncategorized")}</span>
      ),
    },
    {
      accessorKey: "price",
      header: sortHeader(t("columnPrice")),
      meta: { mobile: "secondary" },
      cell: ({ row }) => <PriceText product={row.original} fmt={opts.fmt} salePrice={opts.salePrice} />,
    },
  ];
}
