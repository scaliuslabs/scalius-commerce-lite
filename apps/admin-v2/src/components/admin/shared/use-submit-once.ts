import { useCallback, useRef } from "react";

/**
 * One request at a time from a dialog's submit. A mutation's `isPending` is
 * read from the last render, so a double click (both clicks before React
 * draws again) would pass an `isPending` check twice and send two creates:
 * the second then fails ("already exists") and, as only the latest `mutate`
 * call's callbacks run, the dialog shows that failure for a save that worked.
 * This guard is synchronous: while `send` runs, further submits do nothing.
 *
 * `send` usually calls `mutateAsync`; its failure stays on the mutation
 * (`error`) for the dialog to show, so it is not rethrown here.
 */
export function useSubmitOnce() {
  const inFlight = useRef(false);
  return useCallback((send: () => Promise<unknown>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    void send()
      .catch(() => undefined)
      .finally(() => {
        inFlight.current = false;
      });
  }, []);
}
