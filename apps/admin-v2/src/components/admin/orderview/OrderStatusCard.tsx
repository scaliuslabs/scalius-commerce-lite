import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { AlertTriangle, Receipt, Loader2 } from "lucide-react";
import type { Order } from "./types";
import { useUpdateOrderStatus } from "@/lib/api-mutations/orders";
import { useOrderActionPermissions } from "@/hooks/use-order-action-permissions";
import {
  getAdminOrderCancellationBlockedReason,
  getAdminOrderStatusTransitions,
  isAdminOrderStatus,
} from "@/lib/admin-order-status-policy";

interface OrderStatusCardProps {
  order: Order;
}

export function OrderStatusCard({ order }: OrderStatusCardProps) {
  const orderActions = useOrderActionPermissions();
  const canChangeStatus = orderActions.canChangeOrderStatus;

  const statusMutation = useUpdateOrderStatus();
  const activeRefundOperation = order.activeRefundOperation;
  const refundLocked = Boolean(activeRefundOperation?.active);
  const shipmentLocked = order.shipmentRecovery?.activeLock === true;
  const paymentState = {
    paymentStatus: order.paymentStatus,
    paidAmount: order.paidAmount,
  };
  const availableTransitions = getAdminOrderStatusTransitions(order.status, paymentState);
  const cancellationBlockedReason = getAdminOrderCancellationBlockedReason(
    order.status,
    paymentState,
  );
  const isTerminalStatus = availableTransitions.length === 0;

  const handleStatusChange = (newStatus: string) => {
    if (!isAdminOrderStatus(newStatus)) {
      toast.error("Invalid order status");
      return;
    }
    if (!canChangeStatus) {
      toast.error("Status change unavailable", {
        description: "Your role can view orders but cannot change order status.",
      });
      return;
    }
    if (refundLocked) {
      toast.error("Order locked", { description: "Complete or reconcile the active refund before changing order status." });
      return;
    }
    if (shipmentLocked) {
      toast.error("Shipment recovery active", {
        description: order.shipmentRecovery?.message ?? "Resolve the active shipment recovery before changing order status.",
      });
      return;
    }
    statusMutation.mutate({ orderId: order.id, status: newStatus });
  };

  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b border-border bg-muted/5 px-4 py-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Receipt className="h-4 w-4" />
          Order Status
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 space-y-4">
        <div className="space-y-2">
          <Select
            value={order.status.toLowerCase()}
            onValueChange={handleStatusChange}
            disabled={
              statusMutation.isPending
              || refundLocked
              || shipmentLocked
              || !canChangeStatus
              || isTerminalStatus
            }
          >
            <SelectTrigger
              aria-label="Order status"
              className="h-11 border-border bg-background text-sm text-foreground sm:h-9"
            >
              {statusMutation.isPending ? (
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Updating...</span>
                </div>
              ) : (
                <SelectValue placeholder="Change status" />
              )}
            </SelectTrigger>
            <SelectContent className="border-border bg-card text-foreground">
              {/* Current status (always shown, selected) */}
              <SelectItem
                value={order.status.toLowerCase()}
                className="capitalize text-foreground"
              >
                {order.status.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
              </SelectItem>
              {/* Valid transitions from current status */}
              {availableTransitions.map((status) => (
                <SelectItem
                  key={status}
                  value={status}
                  className="capitalize text-foreground"
                >
                  {status.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!canChangeStatus && (
            <p className="text-sm text-muted-foreground">
              Status changes require order status permission.
            </p>
          )}
          {canChangeStatus && isTerminalStatus && (
            <p className="text-sm text-muted-foreground">
              {order.status.toLowerCase() === "cancelled"
                ? "Cancelled orders cannot be reopened. Create a new order if the sale should continue."
                : "This order status is terminal. Use a dedicated return or refund action when available."}
            </p>
          )}
          {canChangeStatus && cancellationBlockedReason && (
            <p className="text-sm text-muted-foreground">
              {cancellationBlockedReason} Use <span className="font-medium">Issue Refund</span> in the Payment card; a successful full pre-fulfillment refund cancels the order safely.
            </p>
          )}
        </div>

        {activeRefundOperation && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div>
                <p className="font-medium">Order actions locked</p>
                <p className="mt-1">{activeRefundOperation.message}</p>
              </div>
            </div>
          </div>
        )}

        {shipmentLocked && order.shipmentRecovery && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-200">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div>
                <p className="font-medium">{order.shipmentRecovery.label}</p>
                {order.shipmentRecovery.message && <p className="mt-1">{order.shipmentRecovery.message}</p>}
              </div>
            </div>
          </div>
        )}

      </CardContent>
    </Card>
  );
}
