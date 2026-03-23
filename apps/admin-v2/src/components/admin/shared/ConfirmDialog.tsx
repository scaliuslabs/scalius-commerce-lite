import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@scalius/shared/utils";
import { Loader2 } from "lucide-react";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  /** Text for the confirm button. Default: "Confirm" */
  confirmLabel?: string;
  /** Text for the cancel button. Default: "Cancel" */
  cancelLabel?: string;
  /** Variant affects confirm button styling. Default: "destructive" */
  variant?: "destructive" | "default";
  /** Whether the action is in progress (disables buttons, shows spinner) */
  isLoading?: boolean;
  /** Loading text shown on the confirm button while isLoading is true. Defaults to "Processing..." */
  loadingLabel?: string;
  /** Called when user confirms */
  onConfirm: () => void;
  /** Additional className for AlertDialogContent */
  className?: string;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "destructive",
  isLoading = false,
  loadingLabel = "Processing...",
  onConfirm,
  className,
}: ConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className={className}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isLoading}>
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={isLoading}
            className={cn(
              variant === "destructive" &&
                "bg-destructive text-destructive-foreground hover:bg-destructive/90",
            )}
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {loadingLabel}
              </>
            ) : (
              confirmLabel
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ---------------------------------------------------------------------------
// Convenience presets
// ---------------------------------------------------------------------------

interface DeleteConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Name shown in the dialog, e.g. "product", "order" */
  entityName: string;
  isLoading?: boolean;
  onConfirm: () => void;
}

/** Soft-delete confirmation -- moves to trash, restorable. */
export function DeleteConfirmDialog({
  open,
  onOpenChange,
  entityName,
  isLoading,
  onConfirm,
}: DeleteConfirmDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete ${entityName}?`}
      description={`This will move the ${entityName.toLowerCase()} to trash. You can restore it later.`}
      confirmLabel="Delete"
      loadingLabel="Deleting..."
      variant="destructive"
      isLoading={isLoading}
      onConfirm={onConfirm}
    />
  );
}

interface PermanentDeleteConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Name shown in the dialog, e.g. "product", "variant" */
  entityName: string;
  isLoading?: boolean;
  onConfirm: () => void;
}

/** Permanent delete confirmation -- cannot be undone. */
export function PermanentDeleteConfirmDialog({
  open,
  onOpenChange,
  entityName,
  isLoading,
  onConfirm,
}: PermanentDeleteConfirmDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete ${entityName} permanently?`}
      description={`This action cannot be undone. This will permanently delete the ${entityName.toLowerCase()} from your database.`}
      confirmLabel="Yes, delete permanently"
      loadingLabel="Deleting..."
      variant="destructive"
      isLoading={isLoading}
      onConfirm={onConfirm}
    />
  );
}

interface RestoreConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Name shown in the dialog, e.g. "language", "product" */
  entityName: string;
  isLoading?: boolean;
  onConfirm: () => void;
}

/** Restore confirmation -- non-destructive action. */
export function RestoreConfirmDialog({
  open,
  onOpenChange,
  entityName,
  isLoading,
  onConfirm,
}: RestoreConfirmDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Restore ${entityName}?`}
      description={`Are you sure you want to restore the ${entityName.toLowerCase()}?`}
      confirmLabel="Restore"
      loadingLabel="Restoring..."
      variant="default"
      isLoading={isLoading}
      onConfirm={onConfirm}
    />
  );
}
