import { cn } from "@scalius/shared/utils";
import { Checkbox } from "~/components/ui/checkbox";
import { DataTableRowActions } from "~/components/admin/data-table/DataTableRowActions";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { resourceMessages } from "~/i18n/resource";
import {
  ProductStatusBadge,
  ProductThumb,
  ProductTitleLink,
  productShortcodeAction,
  type ProductListItem,
} from "./product-columns";

interface ProductMobileRowProps {
  product: ProductListItem;
  selected: boolean;
  showTrashed: boolean;
  canSelect: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canRestore: boolean;
  canPermanentDelete: boolean;
  fmt: (price: number) => string;
  onSelectedChange: (selected: boolean) => void;
  onOpen: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onPermanentDelete: () => void;
}

/** Phone row: thumb, title and status; then price · category. */
export function ProductMobileRow({
  product,
  selected,
  showTrashed,
  canSelect,
  canEdit,
  canDelete,
  canRestore,
  canPermanentDelete,
  fmt,
  onSelectedChange,
  onOpen,
  onDelete,
  onRestore,
  onPermanentDelete,
}: ProductMobileRowProps) {
  const t = useMessages(productMessages);
  const r = useMessages(resourceMessages);
  return (
    <article className={cn("flex items-center gap-3 bg-background px-3 py-2", selected && "bg-muted")}>
      {canSelect ? (
        <label className="flex h-11 w-6 shrink-0 items-center justify-center">
          <Checkbox
            checked={selected}
            onCheckedChange={(value) => onSelectedChange(value === true)}
            aria-label={r("select", { name: product.name })}
          />
        </label>
      ) : null}
      <ProductThumb src={product.primaryImage} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <ProductTitleLink product={product} />
          <ProductStatusBadge isActive={product.isActive} />
        </div>
        <p className="truncate text-body text-muted-foreground">
          <span className="tabular-nums">{fmt(product.price)}</span> · {product.category.name || t("uncategorized")}
        </p>
      </div>
      <DataTableRowActions
        showTrashed={showTrashed}
        menuLabel={t("actionsFor", { name: product.name })}
        onView={canEdit ? undefined : onOpen}
        onEdit={canEdit ? onOpen : undefined}
        onDelete={canDelete ? onDelete : undefined}
        onRestore={canRestore ? onRestore : undefined}
        onPermanentDelete={canPermanentDelete ? onPermanentDelete : undefined}
        extraActions={showTrashed ? undefined : [productShortcodeAction(product.slug)]}
      />
    </article>
  );
}
