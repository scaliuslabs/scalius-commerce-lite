import { lazy, Suspense, useState } from "react";
import { Button } from "../../ui/button";
import { useMessages } from "~/i18n";
import { itemCountLabel, orderListMessages } from "~/i18n/order-list";

const OrderItemsPopover = lazy(() =>
  import("./OrderItemsPopover").then((module) => ({
    default: module.OrderItemsPopover,
  })),
);

function ItemsTrigger({
  itemCount,
  isLoading = false,
  onActivate,
}: {
  itemCount: number;
  isLoading?: boolean;
  onActivate?: () => void;
}) {
  const t = useMessages(orderListMessages);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={isLoading}
      aria-busy={isLoading || undefined}
      onClick={onActivate}
    >
      {itemCountLabel(t, itemCount)}
    </Button>
  );
}

/** "3 items" button; loads the item list the first time it is opened. */
export function LazyOrderItemsPopover({ orderId, itemCount }: { orderId: string; itemCount: number }) {
  const [shouldLoad, setShouldLoad] = useState(false);
  if (!shouldLoad) {
    return <ItemsTrigger itemCount={itemCount} onActivate={() => setShouldLoad(true)} />;
  }
  return (
    <Suspense fallback={<ItemsTrigger itemCount={itemCount} isLoading />}>
      <OrderItemsPopover orderId={orderId} trigger={<ItemsTrigger itemCount={itemCount} />} />
    </Suspense>
  );
}
