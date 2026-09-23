import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import { useCurrency } from "@/hooks/use-currency";
import { getOrderItems } from "@/lib/api-query-options/orders";
import { queryKeys } from "@/lib/query-keys";
import { useMessages } from "~/i18n";
import { orderListMessages } from "~/i18n/order-list";

/** The order's items in a small popover, opened from the list. */
export function OrderItemsPopover({ orderId, trigger }: { orderId: string; trigger: ReactNode }) {
  const t = useMessages(orderListMessages);
  const { fmt } = useCurrency();
  const [open, setOpen] = useState(true);
  const { data: items, isLoading, isError } = useQuery({
    queryKey: queryKeys.orders.items(orderId),
    queryFn: () => getOrderItems(orderId),
    enabled: open,
    staleTime: 30_000,
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-2">
        <p className="text-body font-medium">{t("items")}</p>
        {isLoading ? (
          <LoaderCircle className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
        ) : isError || !items?.length ? (
          <p className="text-body text-muted-foreground">{t("itemsLoadFailed")}</p>
        ) : (
          <ul className="max-h-60 space-y-2 overflow-y-auto">
            {items.map((item) => (
              <li key={item.id} className="flex items-start justify-between gap-2 text-body">
                <div className="min-w-0">
                  <p className="truncate font-medium">{item.productName || t("unnamedItem")}</p>
                  {item.variantLabel ? (
                    <p className="truncate text-body text-muted-foreground">{item.variantLabel}</p>
                  ) : null}
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-body text-muted-foreground">
                    {t("qtyTimesPrice", { qty: item.quantity, price: fmt(item.price) })}
                  </p>
                  <p className="font-medium">{fmt(item.quantity * item.price)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
