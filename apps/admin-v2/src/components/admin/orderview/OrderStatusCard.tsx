import { useState } from "react";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { AlertTriangle, Receipt, Loader2, Undo2 } from "lucide-react";
import type { Order } from "./types";
import { getAvailableTransitions } from "./types";
import { useUpdateOrderStatus, useReturnOrder } from "@/lib/api-mutations/orders";
import { usePermissions } from "@/contexts/PermissionContext";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";

interface OrderStatusCardProps {
  order: Order;
}

export function OrderStatusCard({ order }: OrderStatusCardProps) {
  const { hasPermission } = usePermissions();
  const canRefund = hasPermission(PERMISSIONS.ORDERS_REFUND);
  const [returnReason, setReturnReason] = useState("");
  const [autoRefund, setAutoRefund] = useState(false);
  const [isReturnDialogOpen, setIsReturnDialogOpen] = useState(false);

  const statusMutation = useUpdateOrderStatus();
  const returnMutation = useReturnOrder();
  const activeRefundOperation = order.activeRefundOperation;
  const refundLocked = Boolean(activeRefundOperation?.active);

  const handleStatusChange = (newStatus: string) => {
    if (refundLocked) {
      toast.error("Order locked", { description: "Complete or reconcile the active refund before changing order status." });
      return;
    }
    statusMutation.mutate({ orderId: order.id, status: newStatus });
  };

  const handleReturnOrder = () => {
    if (!returnReason.trim()) {
      toast.error("Error", { description: "Return reason is required." });
      return;
    }
    if (refundLocked) {
      toast.error("Order locked", { description: "Complete or reconcile the active refund before returning this order." });
      return;
    }

    returnMutation.mutate(
      { orderId: order.id, reason: returnReason, autoRefund: autoRefund && canRefund },
      {
        onSuccess: () => {
          setIsReturnDialogOpen(false);
        },
      },
    );
  };

  const isReturnable = ["delivered", "completed", "shipped"].includes(order.status.toLowerCase());
  const canAutoRefund =
    canRefund &&
    order.paymentStatus !== "unpaid" &&
    order.paymentStatus !== "refunded";

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
            defaultValue={order.status.toLowerCase()}
            onValueChange={handleStatusChange}
            disabled={statusMutation.isPending || refundLocked}
          >
            <SelectTrigger className="h-9 text-sm border-border bg-background text-foreground">
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
              {getAvailableTransitions(order.status).map((status) => (
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
        </div>

        {activeRefundOperation && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div>
                <p className="font-medium">Order actions locked</p>
                <p className="mt-1">{activeRefundOperation.message}</p>
              </div>
            </div>
          </div>
        )}

        {isReturnable && (
          <Dialog open={isReturnDialogOpen} onOpenChange={setIsReturnDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" className="w-full mt-2" size="sm" disabled={refundLocked}>
                <Undo2 className="h-4 w-4 md:mr-2" />
                <span className="hidden md:inline">Return Order</span>
                <span className="md:hidden">Return</span>
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[425px]">
              <DialogHeader>
                <DialogTitle>Return Order</DialogTitle>
                <DialogDescription>
                  Process a return for this order. This will change the order status to Returned and optionally process an automatic refund.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="reason">Return Reason <span className="text-destructive">*</span></Label>
                  <Input
                    id="reason"
                    placeholder="e.g. Defective item, wrong size"
                    value={returnReason}
                    onChange={(e) => setReturnReason(e.target.value)}
                  />
                </div>
                <div className="flex items-center space-x-2 border rounded-md p-3">
                  <Checkbox
                    id="auto-refund"
                    checked={autoRefund}
                    onCheckedChange={(checked) => setAutoRefund(Boolean(checked) && canAutoRefund)}
                    disabled={!canAutoRefund || refundLocked}
                  />
                  <div className="space-y-1 leading-none">
                    <Label
                      htmlFor="auto-refund"
                      className="text-sm font-medium leading-none"
                    >
                      Automatically refund payment
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {refundLocked
                        ? "Locked while refund recovery is active"
                        : order.paymentStatus === "unpaid" || order.paymentStatus === "refunded"
                        ? "Not available (no refundable payment)"
                        : !canRefund
                          ? "Requires refund permission"
                          : "Will attempt to automatically refund the paid amount via the original payment gateway."}
                    </p>
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setIsReturnDialogOpen(false)} disabled={returnMutation.isPending}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={handleReturnOrder} disabled={returnMutation.isPending || refundLocked}>
                  {returnMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Confirm Return
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </CardContent>
    </Card>
  );
}
