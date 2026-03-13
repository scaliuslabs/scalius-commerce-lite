import { TooltipProvider } from "@/components/ui/tooltip";
import type { Order } from "./orderview/types";

// Import the new, refactored components
import { OrderViewHeader } from "./orderview/OrderViewHeader";
import { OrderItemsCard } from "./orderview/OrderItemsCard";
import { OrderStatusCard } from "./orderview/OrderStatusCard";
import { ShipmentCard } from "./orderview/ShipmentCard";
import { OrderNotesCard } from "./orderview/OrderNotesCard";
import { PaymentCard } from "./orderview/PaymentCard";

interface OrderViewProps {
  order: Order;
}

export function OrderView({ order }: OrderViewProps) {
  return (
    <TooltipProvider>
      <div className="container mx-auto max-w-7xl space-y-4 px-4 py-6 sm:space-y-6 sm:px-6 lg:px-8">
        {/* Main Header Card */}
        <OrderViewHeader order={order} />

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:gap-6">
          {/* Left Column for Status, Payment, Shipments, and Notes */}
          <div className="space-y-4 lg:col-span-4">
            <OrderStatusCard order={order} />
            <PaymentCard order={order} />
            <ShipmentCard order={order} />
            <OrderNotesCard order={order} />
          </div>

          {/* Right Column for Order Items */}
          <div className="lg:col-span-8">
            <OrderItemsCard order={order} />
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
