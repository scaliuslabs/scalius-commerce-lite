import { cn } from "@scalius/shared/utils";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";

interface AttributeDeleteDialogProps {
  count: number;
  permanent: boolean;
  open: boolean;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function AttributeDeleteDialog({
  count,
  permanent,
  open,
  pending,
  onOpenChange,
  onConfirm,
}: AttributeDeleteDialogProps) {
  const label = `${count} attribute${count === 1 ? "" : "s"}`;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-base">
            {permanent ? (
              <>
                <AlertTriangle className="h-4 w-4 text-red-500" /> Delete permanently?
              </>
            ) : (
              <>
                <Trash2 className="h-4 w-4 text-amber-500" /> Move to trash?
              </>
            )}
          </AlertDialogTitle>
          <AlertDialogDescription className="pt-1 text-xs">
            {permanent
              ? `${label} will be permanently deleted. This action cannot be undone.`
              : `${label} will move to trash and can be restored later.`}{" "}
            Attributes still assigned to products are protected and will not be deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending} className="h-8 text-xs">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
            disabled={pending}
            className={cn(
              "h-8 text-xs",
              permanent && "bg-destructive hover:bg-destructive/90",
            )}
          >
            {pending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            {permanent ? "Delete permanently" : "Move to trash"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
