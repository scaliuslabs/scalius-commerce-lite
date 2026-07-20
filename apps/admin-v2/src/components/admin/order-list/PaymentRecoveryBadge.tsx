import type { OrderListItem } from "@scalius/core/modules/orders";
import { Badge } from "~/components/ui/badge";
import { AlertTriangle, Clock3, RefreshCw, type LucideIcon } from "lucide-react";

type PaymentRecoverySummary = OrderListItem["paymentRecovery"];
type ActiveRefundOperation = OrderListItem["activeRefundOperation"];
type ShipmentRecoverySummary = OrderListItem["shipmentRecovery"];

const recoveryStyles: Record<
  Exclude<PaymentRecoverySummary["state"], "none">,
  { className: string; icon: LucideIcon }
> = {
  awaiting_payment: {
    className:
      "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-300",
    icon: Clock3,
  },
  processing: {
    className:
      "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300",
    icon: RefreshCw,
  },
  needs_attention: {
    className:
      "border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300",
    icon: AlertTriangle,
  },
};

export function PaymentRecoveryBadge({
  recovery,
  compact = false,
}: {
  recovery: PaymentRecoverySummary | null | undefined;
  compact?: boolean;
}) {
  if (!recovery || recovery.state === "none") return null;

  const style = recoveryStyles[recovery.state];
  const Icon = style.icon;

  return (
    <Badge
      variant="outline"
      className={`inline-flex max-w-full items-center gap-1 truncate rounded-md px-1.5 py-0.5 text-xs font-medium ${style.className}`}
      title={recovery.message ?? recovery.label}
    >
      <Icon className={`h-3 w-3 shrink-0 ${recovery.state === "processing" ? "animate-spin" : ""}`} />
      <span className="truncate">{compact ? "Recovery" : recovery.label}</span>
    </Badge>
  );
}

const refundRecoveryStyles: Record<
  NonNullable<ActiveRefundOperation>["severity"],
  { className: string; icon: LucideIcon }
> = {
  info: {
    className:
      "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-300",
    icon: RefreshCw,
  },
  success: {
    className:
      "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300",
    icon: Clock3,
  },
  warning: {
    className:
      "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300",
    icon: AlertTriangle,
  },
  danger: {
    className:
      "border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300",
    icon: AlertTriangle,
  },
};

export function RefundRecoveryBadge({
  operation,
  compact = false,
}: {
  operation: ActiveRefundOperation | null | undefined;
  compact?: boolean;
}) {
  if (!operation?.active) return null;

  const style = refundRecoveryStyles[operation.severity];
  const Icon = style.icon;

  return (
    <Badge
      variant="outline"
      className={`inline-flex max-w-full items-center gap-1 truncate rounded-md px-1.5 py-0.5 text-xs font-medium ${style.className}`}
      title={operation.message}
    >
      <Icon className={`h-3 w-3 shrink-0 ${operation.severity === "info" ? "animate-spin" : ""}`} />
      <span className="truncate">{compact ? "Refund lock" : operation.label}</span>
    </Badge>
  );
}

const shipmentRecoveryStyles: Record<
  NonNullable<ShipmentRecoverySummary>["severity"],
  { className: string; icon: LucideIcon }
> = {
  info: {
    className:
      "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-300",
    icon: RefreshCw,
  },
  warning: {
    className:
      "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300",
    icon: AlertTriangle,
  },
  danger: {
    className:
      "border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300",
    icon: AlertTriangle,
  },
};

export function ShipmentRecoveryBadge({
  recovery,
  compact = false,
}: {
  recovery: ShipmentRecoverySummary | null | undefined;
  compact?: boolean;
}) {
  if (!recovery || recovery.state === "none") return null;

  const style = shipmentRecoveryStyles[recovery.severity];
  const Icon = style.icon;

  return (
    <Badge
      variant="outline"
      className={`inline-flex max-w-full items-center gap-1 truncate rounded-md px-1.5 py-0.5 text-xs font-medium ${style.className}`}
      title={recovery.message ?? recovery.label}
    >
      <Icon className={`h-3 w-3 shrink-0 ${recovery.state === "creating" ? "animate-spin" : ""}`} />
      <span className="truncate">{compact ? "Shipment" : recovery.label}</span>
    </Badge>
  );
}
