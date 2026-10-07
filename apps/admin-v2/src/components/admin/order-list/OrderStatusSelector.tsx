import { lazy, Suspense, useCallback, useState, type KeyboardEvent } from "react";
import { ChevronDown, LoaderCircle } from "lucide-react";
import { Badge, badgeVariants } from "~/components/ui/badge";
import { statusBadgeVariant } from "~/components/admin/orderview/status-badges";
import { getAdminOrderStatusOptions, type AdminOrderStatusFacts } from "~/lib/admin-order-status-policy";
import { cn } from "@scalius/shared/utils";
import { useMessages } from "~/i18n";
import { orderMessages, orderStatusLabel } from "~/i18n/orders";
import { orderListMessages } from "~/i18n/order-list";

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
  /** Why the status can't change right now; the badge is read-only when set. */
  lockedReason?: string;
  onStatusUpdate: (newStatus: string) => void;
  /** Where the order goes next beyond a status (fulfil, collect cash): the menu links to the order. */
  openOrder?: { orderId: string; label: string };
}

/**
 * The order status as the same badge on every row. When it can change, the
 * badge itself opens the menu of allowed next statuses (a chevron says so),
 * so a changeable row is exactly as tall and wide as a read-only one.
 */
export function OrderStatusSelector({
  status,
  facts,
  isLoading,
  lockedReason,
  onStatusUpdate,
  openOrder,
}: OrderStatusSelectorProps) {
  const t = useMessages(orderMessages);
  const tl = useMessages(orderListMessages);
  const [isMenuRequested, setIsMenuRequested] = useState(false);
  const [open, setOpen] = useState(false);
  const label = orderStatusLabel(t, status);
  const variant = statusBadgeVariant(status, "order");

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

  // A final status (e.g. Cancelled) or a locked order reads as the plain badge.
  if (lockedReason || getAdminOrderStatusOptions(status, facts).length === 0) {
    return <Badge variant={variant} title={lockedReason} data-part="value">{label}</Badge>;
  }

  const trigger = (
    <button
      type="button"
      data-part="value"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={`${tl("changeStatus")}: ${label}`}
      disabled={isLoading}
      onClick={isMenuRequested ? undefined : requestMenuOpen}
      onKeyDown={isMenuRequested ? undefined : handleKeyDown}
      className={cn(
        badgeVariants({ variant }),
        "cursor-pointer hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
      )}
    >
      {label}
      {isLoading ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <ChevronDown aria-hidden="true" />}
    </button>
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
        openOrder={openOrder}
        trigger={trigger}
      />
    </Suspense>
  );
}
