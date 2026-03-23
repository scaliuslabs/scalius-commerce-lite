// src/components/admin/shared/BulkActionDialog.tsx
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

export interface BulkActionConfig {
  title: string;
  description: string;
  confirmLabel?: string;
  variant?: "default" | "destructive";
}

export interface BulkActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentAction: string | null;
  selectedCount: number;
  actionConfigs: Record<string, BulkActionConfig>;
  onConfirm: () => void;
  isLoading?: boolean;
}

const defaultConfig: BulkActionConfig = {
  title: "Confirm Action",
  description: "Are you sure you want to proceed?",
  confirmLabel: "Confirm",
  variant: "default",
};

export function BulkActionDialog({
  open,
  onOpenChange,
  currentAction,
  selectedCount,
  actionConfigs,
  onConfirm,
  isLoading = false,
}: BulkActionDialogProps) {
  const config = currentAction
    ? actionConfigs[currentAction] ?? defaultConfig
    : defaultConfig;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{config.title}</AlertDialogTitle>
          <AlertDialogDescription>
            {config.description}
            {selectedCount > 0 && ` This will affect ${selectedCount} item${selectedCount !== 1 ? "s" : ""}.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isLoading}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={isLoading}
            className={
              config.variant === "destructive"
                ? "bg-destructive hover:bg-destructive/90"
                : ""
            }
          >
            {isLoading ? "Processing..." : (config.confirmLabel ?? "Confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
