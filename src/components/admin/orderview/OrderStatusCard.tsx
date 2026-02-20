import React, { useState } from "react";
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
import { useToast } from "@/hooks/use-toast";
import { Receipt, Loader2, Undo2 } from "lucide-react";
import type { Order } from "./types";
import { ORDER_STATUSES } from "./types";

interface OrderStatusCardProps {
  order: Order;
}

export function OrderStatusCard({ order }: OrderStatusCardProps) {
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isReturning, setIsReturning] = useState(false);
  const [returnReason, setReturnReason] = useState("");
  const [autoRefund, setAutoRefund] = useState(false);
  const [isReturnDialogOpen, setIsReturnDialogOpen] = useState(false);

  const handleStatusChange = async (newStatus: string) => {
    setIsSubmitting(true);
    try {
      const response = await fetch(`/api/orders/${order.id}/status`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || "Failed to update status");
      }

      toast({
        title: "Success",
        description: "Order status has been updated. The page will now reload.",
      });

      setTimeout(() => {
        window.location.reload();
      }, 1500);

    } catch (error) {
      console.error("Error updating status:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error
            ? error.message
            : "Failed to update status. Please try again.",
        variant: "destructive",
      });
      setIsSubmitting(false);
    }
  };

  const handleReturnOrder = async () => {
    if (!returnReason.trim()) {
      toast({ title: "Error", description: "Return reason is required.", variant: "destructive" });
      return;
    }

    setIsReturning(true);
    try {
      const response = await fetch(`/api/orders/${order.id}/return`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: returnReason, autoRefund }),
      });

      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error || "Failed to process return");
      }

      toast({
        title: "Order Returned",
        description: "Order return has been processed successfully.",
      });

      setIsReturnDialogOpen(false);
      setTimeout(() => window.location.reload(), 1500);
    } catch (error) {
      console.error("Error processing return:", error);
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to process return.",
        variant: "destructive",
      });
    } finally {
      setIsReturning(false);
    }
  };

  const isReturnable = ["delivered", "completed", "shipped"].includes(order.status.toLowerCase());

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
            disabled={isSubmitting}
          >
            <SelectTrigger className="h-9 text-sm border-border bg-background text-foreground">
              {isSubmitting ? (
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Updating...</span>
                </div>
              ) : (
                <SelectValue placeholder="Change status" />
              )}
            </SelectTrigger>
            <SelectContent className="border-border bg-card text-foreground">
              {ORDER_STATUSES.map((status) => (
                <SelectItem
                  key={status}
                  value={status}
                  className="capitalize text-foreground"
                >
                  {status.charAt(0).toUpperCase() + status.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {isReturnable && (
          <Dialog open={isReturnDialogOpen} onOpenChange={setIsReturnDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" className="w-full mt-2" size="sm">
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
                    onCheckedChange={(checked) => setAutoRefund(checked as boolean)}
                    disabled={order.paymentStatus === "unpaid" || order.paymentStatus === "refunded"}
                  />
                  <div className="space-y-1 leading-none">
                    <Label
                      htmlFor="auto-refund"
                      className="text-sm font-medium leading-none"
                    >
                      Automatically refund payment
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {order.paymentStatus === "unpaid" || order.paymentStatus === "refunded"
                        ? "Not available (no refundable payment)"
                        : "Will attempt to automatically refund the paid amount via the original payment gateway."}
                    </p>
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setIsReturnDialogOpen(false)} disabled={isReturning}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={handleReturnOrder} disabled={isReturning}>
                  {isReturning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
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