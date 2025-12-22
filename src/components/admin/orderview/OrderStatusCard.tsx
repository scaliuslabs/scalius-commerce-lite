import React from "react";
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
import { useToast } from "@/hooks/use-toast";
import { Receipt, Loader2 } from "lucide-react";
import type { Order } from "./types";
import { ORDER_STATUSES } from "./types";

interface OrderStatusCardProps {
  order: Order;
}

export function OrderStatusCard({ order }: OrderStatusCardProps) {
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = React.useState(false);

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

      // Reload the page to reflect the new status and potentially new UI elements
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

  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b border-border bg-muted/5 px-4 py-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Receipt className="h-4 w-4" />
          Order Status
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4">
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
      </CardContent>
    </Card>
  );
}