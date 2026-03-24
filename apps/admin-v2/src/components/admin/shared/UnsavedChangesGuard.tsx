import { useBlocker } from "@tanstack/react-router";
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

interface UnsavedChangesGuardProps {
  isDirty: boolean;
  isSubmitting: boolean;
}

/**
 * Renders an AlertDialog when the user tries to navigate away from a dirty form.
 * Also enables the browser's native "beforeunload" dialog for tab close / refresh.
 *
 * Usage:
 * ```tsx
 * <UnsavedChangesGuard
 *   isDirty={form.formState.isDirty}
 *   isSubmitting={isSubmitting}
 * />
 * ```
 */
export function UnsavedChangesGuard({
  isDirty,
  isSubmitting,
}: UnsavedChangesGuardProps) {
  const { proceed, reset, status } = useBlocker({
    shouldBlockFn: () => isDirty && !isSubmitting,
    withResolver: true,
    enableBeforeUnload: isDirty && !isSubmitting,
  });

  return (
    <AlertDialog
      open={status === "blocked"}
      onOpenChange={(open) => {
        if (!open) reset?.();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
          <AlertDialogDescription>
            You have unsaved changes that will be lost. Are you sure you want to
            leave this page?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={reset}>Keep Editing</AlertDialogCancel>
          <AlertDialogAction
            onClick={proceed}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Discard Changes
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
