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
import { AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "@scalius/shared/utils";

interface DeleteCustomerDialogProps {
  dialogState: { action: "delete" | "bulk-delete"; id?: string } | undefined;
  showTrashed: boolean;
  isProcessing: boolean;
  selectedCount: number;
  onClose: () => void;
  onConfirmSingle: (id: string) => void;
  onConfirmPermanent: (id: string) => void;
  onConfirmBulk: () => void;
}

export function DeleteCustomerDialog({
  dialogState,
  showTrashed,
  isProcessing,
  selectedCount,
  onClose,
  onConfirmSingle,
  onConfirmPermanent,
  onConfirmBulk,
}: DeleteCustomerDialogProps) {
  return (
    <AlertDialog
      open={!!dialogState}
      onOpenChange={(open) => !open && onClose()}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle
              className={cn(
                "h-6 w-6",
                showTrashed ? "text-destructive" : "text-amber-500",
              )}
            />
            {showTrashed ? "Permanently Delete?" : "Move to Trash?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {dialogState?.action === "bulk-delete"
              ? `You are about to ${showTrashed ? "permanently delete" : "move to trash"} ${selectedCount} customer(s).`
              : "This action will affect the selected customer record."}
            {showTrashed ? (
              <span className="font-semibold text-destructive block mt-2">
                This action is irreversible.
              </span>
            ) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isProcessing}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            className={cn(
              showTrashed && "bg-destructive hover:bg-destructive/90",
            )}
            disabled={isProcessing}
            onClick={() => {
              if (dialogState?.action === "bulk-delete") onConfirmBulk();
              else if (dialogState?.id) {
                if (showTrashed) {
                  onConfirmPermanent(dialogState.id);
                } else {
                  onConfirmSingle(dialogState.id);
                }
              }
            }}
          >
            {isProcessing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            Confirm
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
