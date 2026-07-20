export interface OrderAutoRefreshActivity {
  selectedCount: number;
  actionDialogOpen: boolean;
  mutationInFlight: boolean;
}

/**
 * A background queue refresh must not move the records a merchant is actively
 * selecting or acting on. Explicit mutation invalidation remains separate and
 * may refresh after the command settles.
 */
export function getOrderAutoRefreshPauseReason({
  selectedCount,
  actionDialogOpen,
  mutationInFlight,
}: OrderAutoRefreshActivity): string | null {
  if (selectedCount > 0) {
    return "Auto-refresh is paused while orders are selected.";
  }
  if (actionDialogOpen) {
    return "Auto-refresh is paused while an order action is open.";
  }
  if (mutationInFlight) {
    return "Auto-refresh is paused while an order action is saving.";
  }
  return null;
}
