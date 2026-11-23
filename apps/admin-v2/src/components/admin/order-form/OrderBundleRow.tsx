import { useId, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { orderFormMessages } from "~/i18n/order-form";
import { orderBundleRowMessages } from "~/i18n/order-bundle-row";
import type { OrderItem, Product } from "./types";
import { useOrderFormMoney } from "./order-form-money";
import { orderItemVariantLabel } from "./order-item-presentation";
import { OrderItemQuantityInput } from "./OrderItemQuantityInput";

type ProductVariant = Product["variants"][number];

/**
 * A saved bundle on a staff order as one row: its name, one quantity in whole
 * bundles, one remove, its items behind a disclosure. Loaded only when an
 * order holds a bundle line (OrderItemsTable).
 */
export default function OrderBundleRow({ title, members, units, total, issues, quantityId, onUnitsChange, onRemove }: {
  title: string;
  members: Array<{ index: number; item: OrderItem; product: Product | undefined; resolvedVariantsById: Record<string, ProductVariant> }>;
  /** Whole bundles the order holds. */
  units: number;
  /** The row's amount: its lines summed. */
  total: number;
  issues: string[];
  quantityId: string;
  onUnitsChange: (units: number) => void;
  onRemove: () => void;
}) {
  const t = useMessages(orderFormMessages);
  const b = useMessages(orderBundleRowMessages);
  const { fmt } = useOrderFormMoney();
  const [open, setOpen] = useState(false);
  const id = useId();
  const issueId = `${id}-issue`;
  const listId = `${id}-items`;
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-40">
          <p className="truncate text-body font-medium" title={title}>{title}</p>
          <p className="truncate text-body text-muted-foreground">
            {[b("bundleItems", { count: members.length }), fmt(total / units)].join(" · ")}
          </p>
          <Button type="button" variant="link" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((value) => !value)}>
            {b(open ? "hideBundleItems" : "showBundleItems")}
          </Button>
          {issues.length > 0 ? <p id={issueId} className="text-body text-destructive">{issues.join(" ")}</p> : null}
        </div>
        <OrderItemQuantityInput
          id={quantityId}
          quantity={units}
          itemName={title}
          onQuantityChange={onUnitsChange}
          describedBy={issues.length > 0 ? issueId : undefined}
        />
        <p className="min-w-32 text-end text-body font-medium tabular-nums">{fmt(total)}</p>
        <Button type="button" variant="ghost" size="icon" onClick={onRemove} aria-label={t("remove", { name: title })}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <ul id={listId} hidden={!open} className="flex flex-col gap-1 ps-4 text-body text-muted-foreground" aria-label={b("bundleItemsOf", { name: title })}>
        {members.map(({ index, item, product, resolvedVariantsById }) => {
          const variant = item.variantId ? resolvedVariantsById[item.variantId] ?? product?.variants.find((candidate) => candidate.id === item.variantId) : undefined;
          const variantText = item.variantLabel !== undefined ? item.variantLabel : orderItemVariantLabel(variant);
          return (
            <li key={item.orderItemId ?? index} className="flex justify-between gap-3">
              <span className="min-w-0 truncate">{item.quantity} × {[item.name ?? product?.name ?? t("unknownProduct"), variantText].filter(Boolean).join(" · ")}</span>
            </li>
          );
        })}
      </ul>
    </li>
  );
}
