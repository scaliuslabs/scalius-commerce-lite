import { Link } from "@tanstack/react-router";
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
  CreditCard,
  Package,
  AlertTriangle,
} from "lucide-react";
import type { Order } from "./types";
import { getStatusBadgeClass } from "@scalius/shared/utils";
import { useCurrency } from "@/hooks/use-currency";
import { formatPhoneForDisplay } from "@scalius/shared/customer-utils";
import { formatOrderAmount, formatOrderTimestamp } from "./formatters";
import { useOrderActionPermissions } from "@/hooks/use-order-action-permissions";
import {
  formatSavedMinorAmount,
  resolveSavedOrderMoneySummary,
} from "@/lib/order-tax-presentation";
import { formatLocationParts } from "@/lib/location-presentation";

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
  const { symbol } = useCurrency();
  const savedSummary = resolveSavedOrderMoneySummary(order);
  const shippingLocation = formatLocationParts(
    order.shippingAddress,
    order.areaName,
    order.zoneName,
    order.cityName,
  );
  const orderActions = useOrderActionPermissions();
  const activeRefundOperation = order.activeRefundOperation;
  const refundLocked = Boolean(activeRefundOperation?.active);
  const shipmentLocked = order.shipmentRecovery?.activeLock === true;
  const editLocked = refundLocked || shipmentLocked || !order.fullEditReadiness.allowed;
  const getStatusBadge = (status: string) => {
    const { badgeClass } = getStatusBadgeClass(status);
    return (
      <Badge
        variant="secondary"
        className={`text-xs font-medium ${badgeClass}`}
      >
        {status.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
      </Badge>
    );
  };

  // totalAmount already includes shipping and discount (computed server-side)
  const grandTotal = order.totalAmount;

  const PAYMENT_STATUS_COLORS: Record<string, string> = {
    paid:     "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
    partial:  "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
    unpaid:   "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
    refunded: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
    failed:   "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  };

  const FULFILLMENT_STATUS_COLORS: Record<string, string> = {
    pending:  "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-400",
    partial:  "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
    complete: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  };

  const PAYMENT_METHOD_LABELS: Record<string, string> = {
    stripe: "Stripe",
    sslcommerz: "SSLCommerz",
    cod: "Cash on Delivery",
    polar: "Polar",
  };

  return (
    <div className="relative rounded-xl border border-border bg-card p-4 shadow-sm sm:p-6">
      <div className="grid gap-6 lg:grid-cols-12 lg:gap-8">
        {/* Customer Info */}
        <div className="lg:col-span-5">
          <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="text-xl font-semibold text-foreground">
              <span className="sr-only">Order #{order.id} for </span>
              {order.customerName}
            </h1>
            {getStatusBadge(order.status)}
            {order.customerId && (
              <Link
                to={`/admin/customers/${order.customerId}/history` as string}
                className="inline-flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-muted"
                title="View Customer History"
              >
                <History className="h-4 w-4 text-muted-foreground" />
              </Link>
            )}
          </div>
          <div className="grid gap-4">
            <InfoItem icon={Phone} label="Phone">
              <a
                href={`tel:${order.customerPhone}`}
                className="hover:text-primary"
              >
                {formatPhoneForDisplay(order.customerPhone)}
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
                <div>{shippingLocation}</div>
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
              <span>{formatOrderTimestamp(order.createdAt) ?? "N/A"}</span>
            </InfoItem>
            <InfoItem icon={DollarSign} label="Grand Total">
              <span className="font-semibold">
                {savedSummary
                  ? formatSavedMinorAmount(savedSummary.totalMinor, savedSummary)
                  : `${symbol}${formatOrderAmount(grandTotal)}`}
              </span>
            </InfoItem>
            {order.paymentStatus && (
              <InfoItem icon={CreditCard} label="Payment">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant="secondary"
                    className={`text-xs ${PAYMENT_STATUS_COLORS[order.paymentStatus] ?? ""}`}
                  >
                    {order.paymentStatus.charAt(0).toUpperCase() + order.paymentStatus.slice(1)}
                  </Badge>
                  {order.paymentMethod && (
                    <span className="text-xs text-muted-foreground">
                      {PAYMENT_METHOD_LABELS[order.paymentMethod] ?? order.paymentMethod}
                    </span>
                  )}
                  {activeRefundOperation && (
                    <Badge variant="secondary" className="gap-1 border-amber-200 bg-amber-50 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
                      <AlertTriangle className="h-3 w-3" />
                      Refund recovery
                    </Badge>
                  )}
                </div>
              </InfoItem>
            )}
            {order.fulfillmentStatus && (
              <InfoItem icon={Package} label="Fulfillment">
                <Badge
                  variant="secondary"
                  className={`text-xs font-medium ${FULFILLMENT_STATUS_COLORS[order.fulfillmentStatus] ?? ""}`}
                >
                  {order.fulfillmentStatus.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
                </Badge>
              </InfoItem>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="lg:col-span-3 flex items-start justify-start lg:justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            asChild
            className="h-9 gap-1.5 rounded-lg border-primary/20 px-3 text-sm font-medium hover:bg-primary/5"
          >
            <Link to={`/invoice/${order.id}` as string} target="_blank" rel="noopener noreferrer">
              <Receipt className="h-4 w-4" />
              View invoice
            </Link>
          </Button>
          {orderActions.canEditOrders && (
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5 rounded-lg border-primary/20 px-3 text-sm font-medium hover:bg-primary/5"
              asChild={!editLocked}
              disabled={editLocked}
              title={
                refundLocked
                  ? "Complete or reconcile the active refund before editing this order."
                  : shipmentLocked
                    ? order.shipmentRecovery?.message ?? "Resolve shipment recovery before editing this order."
                    : order.fullEditReadiness.reason ?? undefined
              }
            >
              {editLocked ? (
                <>
                  <Pencil className="h-4 w-4" />
                  Edit locked
                </>
              ) : (
                <Link
                  to="/admin/orders/$orderId/edit"
                  params={{ orderId: order.id }}
                >
                  <Pencil className="h-4 w-4" />
                  Edit Order
                </Link>
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
