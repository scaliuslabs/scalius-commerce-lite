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

interface DeleteOrderDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  isDeleting: boolean;
  onConfirm: () => void;
  showTrashed: boolean;
  isBulk: boolean;
  itemCount: number;
  paymentRecoveryCount?: number;
  activePaymentSetupCount?: number;
  activeRefundCount?: number;
}

export function DeleteOrderDialog({
  isOpen,
  onOpenChange,
  isDeleting,
  onConfirm,
  showTrashed,
  isBulk,
  itemCount,
  paymentRecoveryCount = 0,
  activePaymentSetupCount = 0,
  activeRefundCount = 0,
}: DeleteOrderDialogProps) {
  const isBlocked = activeRefundCount > 0 || activePaymentSetupCount > 0;
  const title = showTrashed
    ? `Delete Order${isBulk ? "s" : ""} Permanently`
    : `Delete Order${isBulk ? "s" : ""}`;
  const description = showTrashed
    ? `This action cannot be undone. This will permanently delete ${isBulk ? itemCount + " orders" : "the order"} from your database.`
    : `This will move ${isBulk ? itemCount + " orders" : "the order"} to trash. You can restore ${isBulk ? "them" : "it"} later from the trash.`;
  const confirmText = showTrashed
    ? "Yes, delete permanently"
    : "Yes, move to trash";
  const deletingText = showTrashed ? "Deleting..." : "Moving to trash...";

  return (
    <AlertDialog open={isOpen} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-md bg-[var(--card)] border-[var(--border)] rounded-xl shadow-lg border backdrop-blur-lg">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-xl font-semibold leading-tight tracking-tight text-[var(--foreground)]">
            {title}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-base text-[var(--muted-foreground)] mt-2">
            {description}
            {paymentRecoveryCount > 0 && (
              <span className="mt-3 block rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                {paymentRecoveryCount} selected order{paymentRecoveryCount === 1 ? "" : "s"} still
                {paymentRecoveryCount === 1 ? " has" : " have"} hosted payment recovery state.
                Active payment setup will be blocked automatically.
              </span>
            )}
            {activePaymentSetupCount > 0 && (
              <span className="mt-3 block rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                {activePaymentSetupCount} selected order{activePaymentSetupCount === 1 ? "" : "s"} still
                {activePaymentSetupCount === 1 ? " has" : " have"} a hosted payment session being prepared.
                Wait for it to finish before deleting.
              </span>
            )}
            {activeRefundCount > 0 && (
              <span className="mt-3 block rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
                {activeRefundCount} selected order{activeRefundCount === 1 ? "" : "s"} still
                {activeRefundCount === 1 ? " has" : " have"} active refund recovery. Complete or reconcile
                the refund before deleting.
              </span>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="mt-4 gap-2">
          <AlertDialogCancel
            disabled={isDeleting}
            className="h-10 transition-all duration-200 hover:bg-[var(--muted)]"
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className={
              showTrashed
                ? "bg-[var(--destructive)] hover:bg-[var(--destructive)]/90 h-10 transition-all duration-200 text-white border-[var(--destructive)]/20 hover:shadow-md focus:ring-2 focus:ring-[var(--destructive)]/40"
                : "h-10 transition-all duration-200 hover:shadow-md focus:ring-2 focus:ring-primary/40"
            }
            disabled={isDeleting || isBlocked}
          >
            {isDeleting ? (
              <>
                <LoaderCircle className="animate-spin -ml-1 mr-2 h-4 w-4" />
                {deletingText}
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
