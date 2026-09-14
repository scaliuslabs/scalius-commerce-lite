import { useBlocker } from "@tanstack/react-router";
import { useEffect } from "react";

import { dispatchAdminNavigationCancelled } from "~/components/admin/shared/admin-navigation-events";

export interface UseUnsavedChangesOptions {
  /** While a save is in flight the guard can be released (default: keep guarding). */
  isSubmitting?: boolean;
  /**
   * Editors that keep workspace state in the query string navigate within the
   * same route while staying on the form. Those navigations must not be blocked.
   */
  allowSamePathNavigation?: boolean;
  /** Turns the guard off entirely (read-only viewers, storybook-style harnesses). */
  disabled?: boolean;
}

export interface UnsavedChangesState {
  /** `blocked` while a navigation is waiting for the operator's answer. */
  status: "idle" | "blocked";
  /** True while the guard is armed (dirty, not submitting, not disabled). */
  isBlocking: boolean;
  /** Continue the blocked navigation and drop the edits. */
  proceed: () => void;
  /** Cancel the blocked navigation and stay on the form. */
  reset: () => void;
}

const noop = () => {};

/**
 * Blocks in-app navigation (TanStack Router `useBlocker`) and tab close /
 * reload (`beforeunload`) while a form has unsaved changes.
 *
 * The router blocker is asked for a resolver so the caller can render its own
 * confirmation dialog; `beforeunload` is registered here rather than through
 * the blocker so the guard also works outside a router (tests, isolated panes).
 */
export function useUnsavedChanges(
  isDirty: boolean,
  options: UseUnsavedChangesOptions = {},
): UnsavedChangesState {
  const { isSubmitting = false, allowSamePathNavigation = false, disabled = false } = options;
  const isBlocking = Boolean(isDirty) && !isSubmitting && !disabled;

  const blocker = useBlocker({
    withResolver: true,
    disabled: !isBlocking,
    // `beforeunload` is owned by the effect below.
    enableBeforeUnload: false,
    shouldBlockFn: ({ current, next }) => {
      if (!isBlocking) return false;
      if (
        allowSamePathNavigation &&
        (current.routeId === next.routeId ||
          current.fullPath === next.fullPath ||
          current.pathname.replace(/\/+$/, "") === next.pathname.replace(/\/+$/, ""))
      ) {
        return false;
      }
      return true;
    },
  });

  useEffect(() => {
    if (!isBlocking || typeof window === "undefined") return;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      // Legacy browsers still need a non-empty returnValue to show the prompt.
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isBlocking]);

  const status = blocker?.status === "blocked" ? "blocked" : "idle";
  const reset = blocker?.reset;

  // The form can become clean while a navigation is parked (the operator saved
  // from the dialog). Release the parked navigation and tell the admin shell so
  // pending navigation UI stops, matching `UnsavedChangesGuard`.
  useEffect(() => {
    if (status === "blocked" && !isBlocking) {
      reset?.();
      dispatchAdminNavigationCancelled();
    }
  }, [isBlocking, reset, status]);

  return {
    status,
    isBlocking,
    proceed: blocker?.proceed ?? noop,
    reset: blocker?.reset ?? noop,
  };
}
