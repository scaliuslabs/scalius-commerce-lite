import { useEffect } from "react";
import { cn } from "@scalius/shared/utils";
import { DialogContent, DialogDescription, DialogTitle } from "~/components/ui/dialog";
import { useMessages } from "~/i18n";
import { mediaMessages } from "~/i18n/media";
import { mediaPickerMessages } from "~/i18n/media-picker";
import { MediaWorkspace } from "./MediaWorkspace";
import { useMediaManager } from "./hooks/useMediaManager";
import { chooseKey, mediaLimitKey, type MediaManagerProps } from "./types";

type MediaManagerInternalProps = MediaManagerProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPendingUploadsChange?: (count: number) => void;
};

export function MediaManager({
  onSelect,
  onSelectMultiple,
  selectedFiles = [],
  unavailableFileIds,
  capability = "image",
  dialogClassName,
  open,
  onOpenChange,
  onCloseAutoFocus,
  onPendingUploadsChange,
}: MediaManagerInternalProps) {
  const t = useMessages(mediaMessages);
  const picker = useMessages(mediaPickerMessages);
  const manager = useMediaManager({
    autoLoad: false,
    capability,
    initialSelectedFiles: selectedFiles,
    unavailableFileIds,
    onSelect,
    onSelectMultiple,
  });

  const pendingUploads = manager.pendingCount;
  useEffect(() => { onPendingUploadsChange?.(pendingUploads); }, [onPendingUploadsChange, pendingUploads]);
  useEffect(() => () => onPendingUploadsChange?.(0), [onPendingUploadsChange]);

  useEffect(() => {
    if (!open) return;
    void manager.load();
    void manager.loadFolders();
    // Folder navigation is a new selection scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, manager.currentFolderId]);

  useEffect(() => {
    if (!open) return;
    manager.replaceSelection(selectedFiles.map((file) => file.id.replace(/^temp_/, "")));
    manager.setSelectionMode(!!onSelectMultiple);
    // Seed the caller's current value once when the dialog opens. A selected
    // value may be highlighted in a single picker, but only a multi-picker uses
    // toggle semantics; clicking another card in a single picker must choose it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    // eslint-disable-next-line shadcn/require-static-classes -- callers add layout only (z-index over the fullscreen editor)
    <DialogContent onCloseAutoFocus={onCloseAutoFocus} className={cn("flex h-[94svh] max-h-[860px] w-full flex-col gap-0 overflow-hidden p-0 sm:w-[96vw] sm:max-w-6xl", dialogClassName)}>
      <div className="flex flex-col gap-1 border-b py-3 ps-4 pe-14">
        <DialogTitle>{picker(chooseKey(capability, !!onSelectMultiple))}</DialogTitle>
        <DialogDescription>{t(mediaLimitKey(capability))}</DialogDescription>
      </div>
      <MediaWorkspace manager={manager} capability={capability} picker multiple={!!onSelectMultiple} onSelect={onSelect} onClose={() => onOpenChange(false)} />
    </DialogContent>
  );
}
