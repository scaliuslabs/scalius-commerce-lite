import { useState } from "react";
import { useMessages } from "~/i18n";
import { saveBarMessages } from "~/i18n/save-bar";

/**
 * Closing a dialog that owns its own form (Esc, outside click, Cancel): a
 * clean form closes at once; unsaved edits ask "Discard unsaved changes?"
 * first, with the save bar's copy. Nothing closes while a save runs. Render
 * `<ConfirmDialog {...discardDialog} />` beside the dialog.
 */
export function useDirtyDialogClose({ dirty, busy = false, onClose }: {
  dirty: boolean;
  busy?: boolean;
  onClose: () => void;
}) {
  const t = useMessages(saveBarMessages);
  const [asking, setAsking] = useState(false);
  const requestClose = () => {
    if (busy) return;
    if (dirty) setAsking(true);
    else onClose();
  };
  return {
    requestClose,
    discardDialog: {
      open: asking && dirty,
      onOpenChange: setAsking,
      title: t("discardTitle"),
      description: t("discardDescription"),
      cancelLabel: t("continueEditing"),
      confirmLabel: t("discardChanges"),
      onConfirm: () => {
        setAsking(false);
        onClose();
      },
    },
  };
}
