import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Phone,
  Mail,
  MapPin,
  Receipt,
  DollarSign,
  CalendarClock,
  Pencil,
  History,
} from "lucide-react";
import type { Order } from "./types";
import { getStatusBadgeClass, formatDate } from "@/lib/utils";

interface OrderViewHeaderProps {
  order: Order;
}

const InfoItem = ({
  icon: Icon,
  label,
  children,
  isAddress = false,
}: {
  icon: React.ElementType;
  label: string;
  children: React.ReactNode;
  isAddress?: boolean;
}) => (
  <div
    className={`flex items-${isAddress ? "start" : "center"} gap-3 text-foreground`}
  >
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
      <Icon className="h-4 w-4 text-primary" />
    </div>
    <div>
      <div className="text-sm font-medium text-muted-foreground">{label}</div>
      <div className={`text-base ${isAddress ? "leading-relaxed" : ""}`}>
        {children}
      </div>
    </div>
  </div>
);

export function OrderViewHeader({ order }: OrderViewHeaderProps) {
  const getStatusBadge = (status: string) => {
    const { badgeClass } = getStatusBadgeClass(status);
    return (
      <Badge
        variant="secondary"
        className={`text-xs font-medium ${badgeClass}`}
      >
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </Badge>
    );
  };

  const grandTotal =
    order.totalAmount + order.shippingCharge - (order.discountAmount ?? 0);

  return (
    <div className="relative rounded-xl border border-border bg-card p-4 shadow-sm sm:p-6">
      <div className="grid gap-6 lg:grid-cols-12 lg:gap-8">
        {/* Customer Info */}
        <div className="lg:col-span-5">
          <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
            <h2 className="text-xl font-semibold text-foreground">
              {order.customerName}
            </h2>
            {getStatusBadge(order.status)}
            {order.customerId && (
              <a
                href={`/admin/customers/${order.customerId}/history`}
                className="inline-flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-muted"
                title="View Customer History"
              >
                <History className="h-4 w-4 text-muted-foreground" />
              </a>
            )}
          </div>
          <div className="grid gap-4">
            <InfoItem icon={Phone} label="Phone">
              <a
                href={`tel:${order.customerPhone}`}
                className="hover:text-primary"
              >
                {order.customerPhone}
              </a>
            </InfoItem>

            {order.customerEmail && (
              <InfoItem icon={Mail} label="Email">
                <a
                  href={`mailto:${order.customerEmail}`}
                  className="hover:text-primary"
                >
                  {order.customerEmail}
                </a>
              </InfoItem>
            )}

            {order.shippingAddress && (
              <InfoItem icon={MapPin} label="Shipping Address" isAddress>
                <div>{order.shippingAddress}</div>
                <div className="text-sm text-muted-foreground">
                  {order.areaName && `${order.areaName}, `}
                  {order.zoneName || "Unknown Zone"},{" "}
                  {order.cityName || "Unknown City"}
                </div>
              </InfoItem>
            )}
          </div>
        </div>

        {/* Vertical Divider */}
        <div className="hidden lg:col-span-1 lg:flex lg:justify-center">
          <div className="w-px bg-border"></div>
        </div>

        {/* Order Summary */}
        <div className="lg:col-span-3">
          <div className="space-y-4">
            <InfoItem icon={Receipt} label="Order ID">
              <span className="font-mono text-sm">#{order.id}</span>
            </InfoItem>
            <InfoItem icon={CalendarClock} label="Order Date">
              {formatDate(order.createdAt)}
            </InfoItem>
            <InfoItem icon={DollarSign} label="Grand Total">
              <span className="font-semibold">
                ৳{grandTotal.toLocaleString()}
              </span>
            </InfoItem>
          </div>
        </div>

        {/* Actions */}
        <div className="lg:col-span-3 flex items-start justify-start lg:justify-end">
          <Button
            variant="outline"
            size="sm"
            asChild
            className="h-9 gap-1.5 rounded-lg border-primary/20 px-3 text-sm font-medium hover:bg-primary/5"
          >
            <a href={`/admin/orders/${order.id}/edit`}>
              <Pencil className="h-4 w-4" />
              Edit Order
            </a>
          </Button>
        </div>
      </div>
    </div>
  );
}
