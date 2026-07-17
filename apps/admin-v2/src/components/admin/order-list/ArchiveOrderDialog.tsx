import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { LoaderCircle } from "lucide-react";

interface ArchiveOrderDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  isArchiving: boolean;
  onConfirm: () => void;
  isBulk: boolean;
  itemCount: number;
  activePaymentSetupCount?: number;
  activeRefundCount?: number;
  shipmentLockCount?: number;
  statusBlockedCount?: number;
}

export function ArchiveOrderDialog({
  isOpen,
  onOpenChange,
  isArchiving,
  onConfirm,
  isBulk,
  itemCount,
  activePaymentSetupCount = 0,
  activeRefundCount = 0,
  shipmentLockCount = 0,
  statusBlockedCount = 0,
}: ArchiveOrderDialogProps) {
  const isBlocked =
    statusBlockedCount > 0 ||
    activeRefundCount > 0 ||
    activePaymentSetupCount > 0 ||
    shipmentLockCount > 0;
  const title = `Archive Order${isBulk ? "s" : ""}`;
  const description = `This hides ${isBulk ? `${itemCount} orders` : "the order"} from the active workspace. Commerce history, inventory, payments, and fulfillment remain unchanged. You can restore ${isBulk ? "them" : "it"} later.`;
  const confirmText = "Archive";

  return (
    <AlertDialog open={isOpen} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-md bg-[var(--card)] border-[var(--border)] rounded-xl shadow-lg border backdrop-blur-lg">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-xl font-semibold leading-tight tracking-tight text-[var(--foreground)]">
            {title}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-base text-[var(--muted-foreground)] mt-2">
            {description}
            {statusBlockedCount > 0 && (
              <span className="mt-3 block rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                {statusBlockedCount} selected order{statusBlockedCount === 1 ? "" : "s"} still
                {statusBlockedCount === 1 ? " has" : " have"} operational work. Complete, cancel,
                return, or fully refund before archiving.
              </span>
            )}
            {activePaymentSetupCount > 0 && (
              <span className="mt-3 block rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                {activePaymentSetupCount} selected order{activePaymentSetupCount === 1 ? "" : "s"} still
                {activePaymentSetupCount === 1 ? " has" : " have"} a hosted payment session being prepared.
                 Wait for it to finish before archiving.
              </span>
            )}
            {activeRefundCount > 0 && (
              <span className="mt-3 block rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
                {activeRefundCount} selected order{activeRefundCount === 1 ? "" : "s"} still
                {activeRefundCount === 1 ? " has" : " have"} active refund recovery. Complete or reconcile
                 the refund before archiving.
              </span>
            )}
            {shipmentLockCount > 0 && (
              <span className="mt-3 block rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
                {shipmentLockCount} selected order{shipmentLockCount === 1 ? "" : "s"} still
                {shipmentLockCount === 1 ? " has" : " have"} active shipment recovery. Resolve the shipment
                 before archiving.
              </span>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="mt-4 gap-2">
          <AlertDialogCancel
            disabled={isArchiving}
            className="h-10 transition-all duration-200 hover:bg-[var(--muted)]"
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className={
              "h-10 transition-all duration-200 hover:shadow-md focus:ring-2 focus:ring-primary/40"
            }
            disabled={isArchiving || isBlocked}
          >
            {isArchiving ? (
              <>
                <LoaderCircle className="animate-spin -ml-1 mr-2 h-4 w-4" />
                Archiving...
              </>
            ) : (
              confirmText
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
