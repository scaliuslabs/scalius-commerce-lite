import { Copy, CopyPlus, Image as ImageIcon } from "lucide-react";
import { toast } from "~/lib/toast";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { cn } from "@scalius/shared/utils";
import { ProductStatusBadge } from "./ProductStatusBadge";
import type { ColumnDef } from "~/components/admin/data-table/table-config";
import { localeWidth } from "~/components/admin/data-table/column-layout";
import type { ExtraAction } from "~/components/admin/data-table/DataTableRowActions";
import { ResourceRowLink } from "~/components/admin/resource/ResourceListPage";
import { sortHeader } from "~/components/admin/resource/columns";
import { translate } from "~/i18n";
import { productMessages, type ProductMessageKey } from "~/i18n/products";
import { salesChannelNamesMessages } from "~/i18n/sales-channel-names";
import type { ProductListItemDto } from "~/lib/api-query-options/products";
import { priceRangeText } from "~/lib/price-range";

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

/** "15 in stock", "62 in stock for 6 variants", or "Not tracked": one line, whole on hover when cut. */
function InventoryText({ product }: { product: ProductListItem }) {
  if (product.onHand === null) return <span className="block truncate text-muted-foreground">{t("notTracked")}</span>;
  const text = product.variantCount > 1
    ? t("inStockVariants", { count: product.onHand, variants: product.variantCount })
    : t("inStock", { count: product.onHand });
  return <span title={text} className={cn("block truncate tabular-nums", product.onHand === 0 ? "text-destructive" : "text-muted-foreground")}>{text}</span>;
}

/** Price customers pay, with the regular price struck through while a product discount runs. */
function PriceText({ product, fmt }: { product: ProductListItem; fmt: (price: number) => string }) {
  const range = product.priceRange;
  const text = priceRangeText(range, fmt);
  // A draft without a price says so instead of looking free.
  if (!range || !text) return <div className="whitespace-nowrap text-muted-foreground">{t("noPrice")}</div>;
  return (
    <div className="whitespace-nowrap tabular-nums">
      {text}
      {range.compareAt !== null && range.from === range.to ? (
        <> <s className="text-muted-foreground">{fmt(range.compareAt)}</s></>
      ) : null}
      {product.hasVariantDiscount ? <div className="text-muted-foreground">{t("saleOnSome")}</div> : null}
    </div>
  );
}

/**
 * Each column's layout: `minWidth` is the widest its content gets in the
 * dashboard's language plus the cell's 6px each side (`list-layout.test.tsx` measures
 * it); `maxWidth` caps free text, cut there with the whole value on hover.
 */
export const PRODUCT_COLUMN_LAYOUT = {
  name: { mobile: "primary", minWidth: 216 },
  status: { mobile: "status", priority: 90, minWidth: 72 },
  // "497 in stock for 20 variants" is 182px (195 in Bangla): it shows whole where the window has room.
  inventory: { mobile: "secondary", priority: 70, maxWidth: 196, minWidth: 208 },
  category: { mobile: "secondary", priority: 40, maxWidth: 140, minWidth: 152 },
  price: { mobile: "secondary", numeric: true, priority: 80, minWidth: { en: 220, bn: 228 } },
  channels: { mobile: "secondary", priority: 30, minWidth: { en: 92, bn: 128 } },
} as const;

/** "3 of 4" sales channels, each named on hover; "None" when the product is on none (MARKETS-DESIGN D6). */
function ChannelsText({ product, channels }: { product: ProductListItem; channels: ReadonlyMap<string, string> }) {
  const count = product.salesChannelIds.length;
  if (count === 0) return <span className="block truncate text-muted-foreground">{translate(salesChannelNamesMessages, "channelsNone")}</span>;
  const names = product.salesChannelIds.map((id) => channels.get(id) ?? id).join(", ");
  return (
    <span title={names} className="block truncate tabular-nums text-muted-foreground">
      {translate(salesChannelNamesMessages, "channelsCount", { count, total: Math.max(channels.size, count) })}
    </span>
  );
}

/**
 * Shopify's products columns: Product (thumbnail and title), Status,
 * Inventory, Category and Price, then any data-backed columns `extra` (apps'
 * fields). Every row is two lines tall: a title takes up to two, or one above
 * a note; the other cells take one, the price two at most.
 */
export function getProductColumns(opts: {
  trashed: boolean;
  fmt: (price: number) => string;
  rowTo: (product: ProductListItem) => string | undefined;
  /** Sales channel names by id: adds the Channels column (Shopify's sales channels count). */
  channels?: ReadonlyMap<string, string>;
  extra?: ColumnDef<ProductListItem, unknown>[];
}): ColumnDef<ProductListItem, unknown>[] {
  return [
    {
      accessorKey: "name",
      header: sortHeader(t("columnProduct")),
      meta: PRODUCT_COLUMN_LAYOUT.name,
      cell: ({ row }) => {
        // Trash explains why "Delete permanently" isn't offered for this one.
        const note = opts.trashed && row.original.hasStockHistory;
        return (
          <div className="flex min-w-0 items-center gap-3">
            <ProductThumb src={row.original.primaryImage} />
            <div className="min-h-[2lh] min-w-0">
              <ResourceRowLink to={opts.trashed ? undefined : opts.rowTo(row.original)} lines={note ? 1 : 2}>
                {row.original.name || t("untitled")}
              </ResourceRowLink>
              {note ? <span title={t("keptForHistory")} className="block truncate text-muted-foreground">{t("keptForHistory")}</span> : null}
            </div>
          </div>
        );
      },
    },
    {
      id: "status",
      header: t("columnStatus"),
      meta: PRODUCT_COLUMN_LAYOUT.status,
      cell: ({ row }) => <ProductStatusBadge isActive={row.original.isActive} />,
      enableSorting: false,
    },
    {
      id: "inventory",
      header: t("columnInventory"),
      meta: PRODUCT_COLUMN_LAYOUT.inventory,
      cell: ({ row }) => <InventoryText product={row.original} />,
      enableSorting: false,
    },
    {
      id: "category",
      accessorFn: (row) => row.category.name,
      header: sortHeader(t("columnCategory")),
      meta: PRODUCT_COLUMN_LAYOUT.category,
      cell: ({ row }) => {
        const name = row.original.category.name || t("uncategorized");
        return <span title={name} className="block truncate text-muted-foreground">{name}</span>;
      },
    },
    {
      accessorKey: "price",
      header: sortHeader(t("columnPrice")),
      meta: { ...PRODUCT_COLUMN_LAYOUT.price, minWidth: localeWidth(PRODUCT_COLUMN_LAYOUT.price.minWidth) },
      cell: ({ row }) => <PriceText product={row.original} fmt={opts.fmt} />,
    },
    ...(opts.channels ? [{
      id: "channels",
      header: translate(salesChannelNamesMessages, "columnChannels"),
      meta: { ...PRODUCT_COLUMN_LAYOUT.channels, minWidth: localeWidth(PRODUCT_COLUMN_LAYOUT.channels.minWidth) },
      cell: ({ row }) => <ChannelsText product={row.original} channels={opts.channels!} />,
      enableSorting: false,
    } satisfies ColumnDef<ProductListItem, unknown>] : []),
    ...(opts.extra ?? []),
  ];
}
