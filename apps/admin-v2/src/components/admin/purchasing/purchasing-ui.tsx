import { forwardRef, type ComponentProps, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "@scalius/shared/utils";
import { NumberInput } from "~/components/ui/number-input";
import { useCurrency } from "~/hooks/use-currency";
import { useMessages } from "~/i18n";
import { purchasingMessages } from "~/i18n/purchasing";

/**
 * A cost in the store currency with its symbol inside the field. Unlike
 * MoneyInput it keeps paisa in taka: costs are not cash amounts.
 */
export const CostInput = forwardRef<HTMLInputElement, Omit<ComponentProps<typeof NumberInput>, "integer" | "wholeUnitsMessage">>(
  ({ className, ...props }, ref) => {
    const { symbol } = useCurrency();
    return (
      <div className={cn("relative", className)}>
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 inset-s-3 flex items-center text-body text-muted-foreground">
          {symbol}
        </span>
        <NumberInput
          ref={ref}
          {...props}
          // eslint-disable-next-line shadcn/no-restyle -- room for the currency symbol inside the field
          className="ps-7"
        />
      </div>
    );
  },
);
CostInput.displayName = "CostInput";

/** "1 unit" / "12 units" in the dashboard language. */
export function useUnitsText() {
  const t = useMessages(purchasingMessages);
  return (count: number) => (count === 1 ? t("unitsOne") : t("units", { count }));
}

/** A document line's product: its name (a link to the product), option values and SKU. */
export function LineProduct({ line, retired = false }: {
  line: { productId: string; productName: string | null; optionLabel: string | null; sku: string };
  retired?: boolean;
}) {
  const t = useMessages(purchasingMessages);
  return (
    <span className="block min-w-0 space-y-0.5">
      <span className="line-clamp-2 break-words font-medium">
        <Link to="/admin/products/$productId/edit" params={{ productId: line.productId }} className="hover:underline">
          {line.productName ?? t("unknownProduct")}
        </Link>
      </span>
      {line.optionLabel ? <span className="block truncate text-muted-foreground" title={line.optionLabel}>{line.optionLabel}</span> : null}
      <span className="block truncate font-mono text-muted-foreground" title={line.sku}>{line.sku}</span>
      {retired ? <span className="block text-destructive">{t("retired")}</span> : null}
    </span>
  );
}

/** One fact in a details card: a muted label over its value. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-body text-muted-foreground">{label}</dt>
      <dd className="break-words text-body">{children}</dd>
    </div>
  );
}

/** A label and an amount on one line of a summary (subtotal, shipping, total). */
export function SummaryRow({ label, detail, children, strong = false }: {
  label: ReactNode;
  detail?: ReactNode;
  children: ReactNode;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={strong ? "text-body font-medium" : "text-body"}>
        {label}
        {detail ? <span className="text-muted-foreground"> · {detail}</span> : null}
      </dt>
      <dd className={strong ? "text-body font-medium tabular-nums" : "text-body tabular-nums"}>{children}</dd>
    </div>
  );
}
