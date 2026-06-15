import { lazy, Suspense, useState } from "react";
import { cn } from "@scalius/shared/utils";
import { badgeVariants } from "../../ui/badge";

const OrderItemsPopover = lazy(() =>
  import("./OrderItemsPopover").then((module) => ({
    default: module.OrderItemsPopover,
  })),
);

interface LazyOrderItemsPopoverProps {
  orderId: string;
  itemCount: number;
}

interface OrderItemsTriggerShellProps {
  itemCount: number;
  isLoading?: boolean;
  onActivate?: () => void;
}

function OrderItemsTriggerShell({
  itemCount,
  isLoading = false,
  onActivate,
}: OrderItemsTriggerShellProps) {
  const label = `${itemCount.toLocaleString()} ${
    itemCount === 1 ? "item" : "items"
  }`;

  return (
    <button
      type="button"
      className={cn(
        badgeVariants({ variant: "secondary" }),
        "cursor-pointer text-xs font-medium transition-all duration-200 hover:scale-105 hover:bg-[var(--muted)]",
      )}
      disabled={isLoading}
      aria-busy={isLoading || undefined}
      aria-label={`View ${label}`}
      onClick={onActivate}
    >
      {label}
    </button>
  );
}

export function LazyOrderItemsPopover({
  orderId,
  itemCount,
}: LazyOrderItemsPopoverProps) {
  const [shouldLoad, setShouldLoad] = useState(false);

  if (!shouldLoad) {
    return (
      <OrderItemsTriggerShell
        itemCount={itemCount}
        onActivate={() => setShouldLoad(true)}
      />
    );
  }

  return (
    <Suspense
      fallback={<OrderItemsTriggerShell itemCount={itemCount} isLoading />}
    >
      <OrderItemsPopover
        orderId={orderId}
        itemCount={itemCount}
        initialOpen
      />
    </Suspense>
  );
}
