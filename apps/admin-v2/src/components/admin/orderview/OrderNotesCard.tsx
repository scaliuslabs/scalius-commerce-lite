import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertCircle } from "lucide-react";
import type { Order } from "./types";

interface OrderNotesCardProps {
  order: Order;
}

export function OrderNotesCard({ order }: OrderNotesCardProps) {
  // This component will not render if there are no notes,
  // the logic is handled in the parent OrderView component.
  if (!order.notes) {
    return null;
  }

  return (
    <Card className="mt-6 overflow-hidden">
      <CardHeader className="border-b border-border bg-muted/5 px-4 py-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertCircle className="h-4 w-4" />
          Order Notes
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4">
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">
          {order.notes}
        </p>
      </CardContent>
    </Card>
  );
}
