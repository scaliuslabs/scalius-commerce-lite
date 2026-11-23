import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Trash2 } from "lucide-react";
import type { OrderItem, Product } from "./types";
import { useOrderForm } from "./OrderFormContext";
import { useOrderFormMoney } from "./order-form-money";
import { fromMinor } from "@scalius/shared/money";
import { useMessages } from "~/i18n";
import { useLineEntryText } from "~/lib/line-entry-text";
import { orderFormMessages } from "~/i18n/order-form";
import { orderItemVariantLabel } from "./order-item-presentation";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { OrderItemQuantityInput } from "./OrderItemQuantityInput";
import {
  exceededStockMessage,
  remainingStockForNewOrderLine,
} from "./manual-order-stock";

type ProductVariant = Product["variants"][number];

export const orderLineQuantityId = (index: number) => `order-line-${index}-quantity`;

interface OrderItemsTableProps {
  resolvedVariantsById?: Record<string, ProductVariant>;
}

/**
 * The order's lines: product, variant, quantity, line total and remove. Line
 * totals are before the order discount, so they add up to the subtotal.
 */
export function OrderItemsTable({ resolvedVariantsById = {} }: OrderItemsTableProps) {
  const { form, products, isEdit, manualQuote } = useOrderForm();
  const { fmt, code } = useOrderFormMoney();
  const surcharge = (priceMinor: number) => fmt(priceMinor / 10 ** getDecimalPlaces(code));
  const t = useMessages(orderFormMessages);
  // The platform's words on a line ("Yes", "Add-on") in the dashboard's language.
  const present = useLineEntryText();
  const items = form.watch("items") as OrderItem[];
  // The quote's amounts are minor units of its own currency.
  const quoted = (amountMinor: number) => fromMinor(amountMinor, manualQuote.data!.decimalPlaces);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const setItems = (next: OrderItem[]) =>
    form.setValue("items", next, { shouldDirty: true, shouldValidate: true });

  const handleQuantityChange = (index: number, quantity: number) => {
    const currentItems = [...form.getValues("items")];
    const currentItem = currentItems[index];
    if (!currentItem || currentItem.quantity === quantity) return;
    currentItems[index] = { ...currentItem, quantity };
    setItems(currentItems);
  };

  if (items.length === 0) {
    return (
      <div className="space-y-1 border-t pt-6 pb-2 text-center">
        <p className="text-body font-medium">{t("noItems")}</p>
        <p className="text-body text-muted-foreground">{t("noItemsHint")}</p>
      </div>
    );
  }

  // The quote numbers its lines by the form's rows: a bundle's items all name its row.
  const quotedRows = (indices: readonly number[]) => {
    if (!manualQuote.isCurrent || !manualQuote.data) return null;
    const lines = manualQuote.data.lines.filter((line) => indices.includes(line.index));
    if (lines.length === 0) return null;
    // A plain row's lines are its own SKU at its quantity; anything else is a quote of other rows.
    const plain = indices.length === 1 && lines.every((line) => line.variantId === items[indices[0]!]?.variantId);
    if (plain && lines.reduce((sum, line) => sum + line.quantity, 0) !== items[indices[0]!]?.quantity) return null;
    return { totalMinor: lines.reduce((sum, line) => sum + line.lineSubtotalMinor, 0) };
  };
  const issuesOf = (indices: readonly number[]) =>
    [...new Set((manualQuote.itemIssues ?? []).filter((entry) => indices.includes(entry.index)).map((entry) => entry.message))];
  const rows = orderRows(items);
  const removeRows = (indices: readonly number[]) =>
    setItems(form.getValues("items").filter((_, i) => !indices.includes(i)));

  return (
    <ul className="divide-y border-t">
      {rows.map((row) => {
        if (row.kind === "bundle") {
          const first = row.members[0]!;
          const units = Math.max(1, Math.round(items[first]!.quantity / items[first]!.bundle!.perUnit));
          const quotedRow = quotedRows(row.members);
          const total = quotedRow ? quoted(quotedRow.totalMinor) : row.members.reduce((sum, index) => sum + items[index]!.price * items[index]!.quantity, 0);
          const issues = issuesOf(row.members);
          const issueId = `order-line-issue-${first}`;
          const listId = `order-bundle-items-${first}`;
          const open = expanded.has(row.id);
          return (
            <li key={`bundle-${row.id}`} className="flex flex-col gap-2 py-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="min-w-0 flex-1 basis-40">
                  <p className="truncate text-body font-medium" title={row.title}>{row.title}</p>
                  <p className="truncate text-body text-muted-foreground">
                    {[t("bundleItems", { count: row.members.length }), fmt(total / units)].join(" · ")}
                  </p>
                  <Button
                    type="button"
                    variant="link"
                    aria-expanded={open}
                    aria-controls={listId}
                    onClick={() => setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(row.id)) next.delete(row.id);
                      else next.add(row.id);
                      return next;
                    })}
                  >
                    {t(open ? "hideBundleItems" : "showBundleItems")}
                  </Button>
                  {issues.length > 0 ? <p id={issueId} className="text-body text-destructive">{issues.join(" ")}</p> : null}
                </div>
                <OrderItemQuantityInput
                  id={orderLineQuantityId(first)}
                  quantity={units}
                  itemName={row.title}
                  onQuantityChange={(next) => {
                    // A bundle changes whole: each of its lines holds its units per bundle times the bundles.
                    const current = [...form.getValues("items")];
                    for (const index of row.members) {
                      const line = current[index];
                      if (line?.bundle) current[index] = { ...line, quantity: next * line.bundle.perUnit };
                    }
                    setItems(current);
                  }}
                  describedBy={issues.length > 0 ? issueId : undefined}
                />
                <p className="min-w-32 text-end text-body font-medium tabular-nums">{fmt(total)}</p>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeRows(row.members)}
                  aria-label={t("remove", { name: row.title })}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <ul id={listId} hidden={!open} className="flex flex-col gap-1 ps-4 text-body text-muted-foreground" aria-label={t("bundleItemsOf", { name: row.title })}>
                {row.members.map((index) => {
                  const item = items[index]!;
                  const product = products.find((candidate) => candidate.id === item.productId);
                  const variant = item.variantId ? resolvedVariantsById[item.variantId] ?? product?.variants.find((candidate) => candidate.id === item.variantId) : undefined;
                  const variantText = item.variantLabel !== undefined ? item.variantLabel : orderItemVariantLabel(variant);
                  return (
                    <li key={`${item.orderItemId ?? index}`} className="flex justify-between gap-3">
                      <span className="min-w-0 truncate">{item.quantity} × {[item.name ?? product?.name ?? t("unknownProduct"), variantText].filter(Boolean).join(" · ")}</span>
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        }
        const index = row.index;
        const item = items[index]!;
        const product = products.find((candidate) => candidate.id === item.productId);
        const variant = item.variantId
          ? resolvedVariantsById[item.variantId]
            ?? product?.variants.find((candidate) => candidate.id === item.variantId)
          : undefined;
        const quotedRow = quotedRows([index]);
        const maximumQuantity = isEdit
          ? null
          : remainingStockForNewOrderLine(variant, items, index);
        const name = item.name ?? product?.name ?? t("unknownProduct");
        const issues = issuesOf([index]);
        const issueId = `order-line-issue-${index}`;
        const variantText = item.variantLabel !== undefined
          ? item.variantLabel
          : orderItemVariantLabel(variant);
        // A row's amount is its quote lines summed (a new bundle is several); its unit, that over its quantity.
        const total = quotedRow ? quoted(quotedRow.totalMinor) : item.price * item.quantity;

        return (
          <li
            key={`${item.productId}-${item.variantId ?? "sku"}-${index}`}
            className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3"
          >
            <div className="min-w-0 flex-1 basis-40">
              <p className="truncate text-body font-medium">{name}</p>
              <p className="truncate text-body text-muted-foreground">
                {[variantText, fmt(quotedRow ? total / item.quantity : item.price)].filter(Boolean).join(" · ")}
              </p>
              {item.propertiesDisplay?.length ? (
                <ul className="text-body text-muted-foreground" aria-label={t("buyerInputs")}>
                  {item.propertiesDisplay.map(present).map((property) => (
                    <li key={property.key} className="break-words">
                      {property.label}: {property.displayValue}
                      {property.priceMinor > 0 ? <span className="tabular-nums"> (+{surcharge(property.priceMinor)})</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {issues.length > 0 ? <p id={issueId} className="text-body text-destructive">{issues.join(" ")}</p> : null}
            </div>
            <OrderItemQuantityInput
              id={orderLineQuantityId(index)}
              quantity={item.quantity}
              itemName={name}
              onQuantityChange={(quantity) => handleQuantityChange(index, quantity)}
              maxQuantity={maximumQuantity ?? undefined}
              describedBy={issues.length > 0 ? issueId : undefined}
              maximumExceededMessage={maximumQuantity === null
                ? undefined
                : exceededStockMessage(maximumQuantity)}
            />
            {/* Wide enough for a lakh-sized line total, so every row's quantity field sits in one column. */}
            <p className="min-w-32 text-end text-body font-medium tabular-nums">
              {fmt(total)}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => removeRows([index])}
              aria-label={t("remove", { name })}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

type OrderRow = { kind: "line"; index: number } | { kind: "bundle"; id: string; title: string; members: number[] };

/**
 * The form's rows: each line, except a saved bundle's lines, which are one
 * row (in the place of its first line) changed and removed whole.
 */
export function orderRows(items: readonly OrderItem[]): OrderRow[] {
  const rows: OrderRow[] = [];
  const bundles = new Map<string, Extract<OrderRow, { kind: "bundle" }>>();
  items.forEach((item, index) => {
    if (!item.bundle || !item.orderItemId) {
      rows.push({ kind: "line", index });
      return;
    }
    const known = bundles.get(item.bundle.id);
    if (known) {
      known.members.push(index);
      return;
    }
    const row = { kind: "bundle" as const, id: item.bundle.id, title: item.bundle.title, members: [index] };
    bundles.set(item.bundle.id, row);
    rows.push(row);
  });
  return rows;
}
