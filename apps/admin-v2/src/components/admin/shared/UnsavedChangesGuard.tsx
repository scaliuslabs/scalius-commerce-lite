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
} from "../../ui/alert-dialog";
import { dispatchAdminNavigationCancelled } from "./admin-navigation-events";

interface UnsavedChangesGuardProps {
  isDirty: boolean;
  isSubmitting: boolean;
  allowSamePathStateNavigation?: boolean;
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
  allowSamePathStateNavigation = false,
}: UnsavedChangesGuardProps) {
  const { proceed, reset, status } = useBlocker({
    shouldBlockFn: ({ current, next }) => {
      if (!isDirty || isSubmitting) return false;

      // Some editors keep non-sensitive workspace state in the query string.
      // Moving between those states does not leave the form or discard it, so
      // the global leave-page guard must not intercept that navigation.
      if (
        allowSamePathStateNavigation &&
        (
          current.routeId === next.routeId ||
          current.fullPath === next.fullPath ||
          current.pathname.replace(/\/+$/, "") ===
            next.pathname.replace(/\/+$/, "")
        )
      ) {
        return false;
      }

      return true;
    },
    withResolver: true,
    enableBeforeUnload: isDirty && !isSubmitting,
  });

  function keepEditing() {
    reset?.();
    dispatchAdminNavigationCancelled();
  }

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
          <AlertDialogCancel onClick={keepEditing}>Keep Editing</AlertDialogCancel>
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
