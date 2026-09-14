import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@scalius/shared/utils";
import { dispatchAdminNavigationCancelled } from "~/components/admin/shared/admin-navigation-events";
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
import { Button } from "~/components/ui/button";

import { useUnsavedChanges } from "./useUnsavedChanges";

export interface ContextualSaveBarProps {
  /** The bar renders nothing until the form is dirty. */
  isDirty: boolean;
  onSave: () => void;
  /** Must restore the last saved values, including any pending sub-inputs. */
  onDiscard: () => void;
  /** Default: "Unsaved changes". */
  message?: string;
  /** Default: "Save". */
  saveLabel?: string;
  /** Default: "Discard". */
  discardLabel?: string;
  /** A save is in flight: the bar shows a spinner and locks both actions. */
  saving?: boolean;
  /** The draft is invalid; Save stays disabled and explains why. */
  saveDisabled?: boolean;
  saveDisabledReason?: string;
  /** False when the operator may view but not edit; both actions lock. */
  canSave?: boolean;
  /** Discard is offered but not available yet (nothing to fall back to). */
  discardDisabled?: boolean;
  /**
   * Drops Discard entirely. Only for a bar whose change genuinely cannot be
   * undone here — a first publication with no earlier version to restore.
   */
  hideDiscard?: boolean;
  /** Guard in-app navigation and tab close. Default: true. */
  blockNavigation?: boolean;
  /** Query-string-only navigation inside the same route stays allowed. */
  allowSamePathNavigation?: boolean;
  /** Positioning classes; override when a sticky page chrome sits above. */
  stickyClassName?: string;
  /** Extra left-side content, e.g. a short validation summary. */
  children?: ReactNode;
  className?: string;
}

/**
 * Shopify-style contextual save bar: it appears at the top of the content area
 * only while the form is dirty, announces itself politely, and owns the page's
 * Save/Discard pair. Settings pages must not add per-card Save buttons.
 *
 * Navigation blocking is wired in here (`useUnsavedChanges`) because the bar is
 * mounted exactly while there is something to lose.
 */
export function ContextualSaveBar({
  isDirty,
  onSave,
  onDiscard,
  message = "Unsaved changes",
  saveLabel = "Save",
  discardLabel = "Discard",
  saving = false,
  saveDisabled = false,
  saveDisabledReason,
  canSave = true,
  discardDisabled = false,
  hideDiscard = false,
  blockNavigation = true,
  allowSamePathNavigation = false,
  stickyClassName = "sticky top-0 z-30",
  children,
  className,
}: ContextualSaveBarProps) {
  const guard = useUnsavedChanges(isDirty, {
    allowSamePathNavigation,
    disabled: !blockNavigation,
  });

  if (!isDirty) return null;

  const locked = saving || !canSave;

  return (
    <>
      <div
        role="status"
        aria-live="polite"
        aria-busy={saving || undefined}
        data-testid="contextual-save-bar"
        className={cn(
          stickyClassName,
          "-mx-3 mb-4 flex flex-col gap-2 border-b border-border bg-background/95 px-3 py-2 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:-mx-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-4",
          className,
        )}
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">{message}</span>
          {children}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2">
          {hideDiscard ? null : (
            <Button
              type="button"
              variant="outline"
              data-testid="contextual-save-bar-discard"
              className="min-h-11 flex-1 sm:min-h-9 sm:flex-none"
              disabled={locked || discardDisabled}
              onClick={onDiscard}
            >
              {discardLabel}
            </Button>
          )}
          <Button
            type="button"
            data-testid="contextual-save-bar-save"
            className="min-h-11 flex-1 sm:min-h-9 sm:flex-none sm:min-w-28"
            disabled={locked || saveDisabled}
            title={saveDisabled ? saveDisabledReason : undefined}
            onClick={onSave}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {saving ? "Saving" : saveLabel}
          </Button>
        </div>
      </div>

      {blockNavigation ? (
        <AlertDialog
          open={guard.status === "blocked"}
          onOpenChange={(open) => {
            if (!open) guard.reset();
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
              <AlertDialogDescription>
                Your unsaved changes on this page will be discarded.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel
                onClick={() => {
                  guard.reset();
                  dispatchAdminNavigationCancelled();
                }}
              >
                Keep editing
              </AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => guard.proceed()}>
                Discard changes
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </>
  );
}

export default ContextualSaveBar;
