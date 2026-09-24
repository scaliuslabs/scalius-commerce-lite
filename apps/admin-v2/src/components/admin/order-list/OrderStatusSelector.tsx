import { lazy, Suspense, useCallback, useState, type KeyboardEvent } from "react";
import { ChevronDown, LoaderCircle } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { statusBadgeVariant } from "~/components/admin/orderview/status-badges";
import { getAdminOrderStatusOptions, type AdminOrderStatusFacts } from "~/lib/admin-order-status-policy";
import { useMessages } from "~/i18n";
import { orderMessages, orderStatusLabel } from "~/i18n/orders";

const LazyOrderStatusSelectorMenu = lazy(() =>
  import("./OrderStatusSelectorMenu").then((module) => ({
    default: module.OrderStatusSelectorMenu,
  })),
);

interface OrderStatusSelectorProps {
  status: string;
  /** Payment and delivery facts that decide which next statuses can be chosen. */
  facts: AdminOrderStatusFacts;
  isLoading: boolean;
  /** Why the status can't change right now; the selector is read-only when set. */
  lockedReason?: string;
  onStatusUpdate: (newStatus: string) => void;
}

/** Order status with an inline menu of the allowed next statuses. */
export function OrderStatusSelector({
  status,
  facts,
  isLoading,
  lockedReason,
  onStatusUpdate,
}: OrderStatusSelectorProps) {
  const t = useMessages(orderMessages);
  const [isMenuRequested, setIsMenuRequested] = useState(false);
  const [open, setOpen] = useState(false);
  const label = orderStatusLabel(t, status);

  const requestMenuOpen = useCallback(() => {
    if (isLoading) return;
    setIsMenuRequested(true);
    setOpen(true);
  }, [isLoading]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== "Enter" && event.key !== " " && event.key !== "ArrowDown") return;
      event.preventDefault();
      requestMenuOpen();
    },
    [requestMenuOpen],
  );

  // A final status (e.g. Cancelled) reads as plain status, without a menu that offers nothing.
  if (lockedReason || getAdminOrderStatusOptions(status, facts).length === 0) {
    return (
      <Badge variant={statusBadgeVariant(status, "order")} title={lockedReason}>
        {label}
      </Badge>
    );
  }

  const trigger = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={isLoading}
      onClick={isMenuRequested ? undefined : requestMenuOpen}
      onKeyDown={isMenuRequested ? undefined : handleKeyDown}
    >
      {isLoading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
      {label}
      <ChevronDown className="h-4 w-4 text-muted-foreground" />
    </Button>
  );

  if (!isMenuRequested) return trigger;
  return (
    <Suspense fallback={trigger}>
      <LazyOrderStatusSelectorMenu
        status={status}
        facts={facts}
        open={open}
        onOpenChange={setOpen}
        onStatusUpdate={onStatusUpdate}
        trigger={trigger}
      />
    </Suspense>
  );
}
