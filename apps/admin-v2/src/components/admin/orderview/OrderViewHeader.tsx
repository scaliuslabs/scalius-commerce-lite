import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Receipt,
  Pencil,
  History,
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
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5">
      <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              Order #{order.id}
            </h1>
            {getStatusBadge(order.status)}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatOrderTimestamp(order.createdAt) ?? "Date unavailable"}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            asChild
            className="h-11 gap-1.5 rounded-lg border-primary/20 px-3 text-sm font-medium hover:bg-primary/5 sm:h-9"
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
              className="h-11 gap-1.5 rounded-lg border-primary/20 px-3 text-sm font-medium hover:bg-primary/5 sm:h-9"
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
                  Edit order
                </Link>
              )}
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-5 pt-4 md:grid-cols-[1.05fr_1.35fr_1fr] md:divide-x">
        <section className="min-w-0 md:pr-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-xs font-medium text-muted-foreground">Customer</h2>
              <p className="mt-1 truncate text-sm font-semibold">{order.customerName}</p>
            </div>
            {order.customerId ? (
              <Button asChild variant="ghost" size="sm" className="h-9 shrink-0 gap-1.5 px-2 text-xs">
                <Link to={`/admin/customers/${order.customerId}/history` as string}>
                  <History className="h-3.5 w-3.5" />
                  View
                </Link>
              </Button>
            ) : null}
          </div>
          <a
            href={`tel:${order.customerPhone}`}
            className="mt-1 inline-flex min-h-11 items-center text-sm text-muted-foreground hover:text-primary sm:min-h-0"
          >
            {formatPhoneForDisplay(order.customerPhone)}
          </a>
          {order.customerEmail ? (
            <a
              href={`mailto:${order.customerEmail}`}
              className="block min-h-11 break-all py-2 text-sm text-muted-foreground hover:text-primary sm:min-h-0 sm:py-0.5"
            >
              {order.customerEmail}
            </a>
          ) : null}
        </section>

        <section className="min-w-0 md:px-5">
          <h2 className="text-xs font-medium text-muted-foreground">Delivery address</h2>
          <p className="mt-1 text-sm leading-6">{shippingLocation || "No address"}</p>
        </section>

        <section className="min-w-0 md:pl-5">
          <h2 className="text-xs font-medium text-muted-foreground">Total</h2>
          <p className="mt-1 text-lg font-semibold">
            {savedSummary
              ? formatSavedMinorAmount(savedSummary.totalMinor, savedSummary)
              : `${symbol}${formatOrderAmount(grandTotal)}`}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {order.paymentStatus ? (
              <Badge
                variant="secondary"
                className={`text-xs ${PAYMENT_STATUS_COLORS[order.paymentStatus] ?? ""}`}
              >
                {order.paymentStatus.charAt(0).toUpperCase() + order.paymentStatus.slice(1)}
              </Badge>
            ) : null}
            {order.paymentMethod ? (
              <span className="text-xs text-muted-foreground">
                {PAYMENT_METHOD_LABELS[order.paymentMethod] ?? order.paymentMethod}
              </span>
            ) : null}
            {order.fulfillmentStatus ? (
              <Badge
                variant="secondary"
                className={`text-xs font-medium ${FULFILLMENT_STATUS_COLORS[order.fulfillmentStatus] ?? ""}`}
              >
                {order.fulfillmentStatus.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase())}
              </Badge>
            ) : null}
            {activeRefundOperation ? (
              <Badge variant="secondary" className="gap-1 border-amber-200 bg-amber-50 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
                <AlertTriangle className="h-3 w-3" />
                Refund recovery
              </Badge>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
