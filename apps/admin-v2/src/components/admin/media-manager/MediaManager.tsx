import { useEffect } from "react";
import { DialogContent, DialogDescription, DialogTitle } from "~/components/ui/dialog";
import { MediaWorkspace } from "./MediaWorkspace";
import { useMediaManager } from "./hooks/useMediaManager";
import type { MediaManagerProps } from "./types";

type MediaManagerInternalProps = MediaManagerProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
}: MediaManagerInternalProps) {
  const manager = useMediaManager({
    autoLoad: false,
    capability,
    initialSelectedFiles: selectedFiles,
    unavailableFileIds,
    onSelect: onSelect ? (file) => { onOpenChange(false); onSelect(file); } : undefined,
    onSelectMultiple: onSelectMultiple ? (files) => { onOpenChange(false); onSelectMultiple(files); } : undefined,
  });

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
    <DialogContent
      showCloseButton={false}
      className={`h-[94svh] max-h-[860px] w-[96vw] max-w-7xl overflow-hidden p-0 ${dialogClassName ?? ""}`}
    >
      <DialogTitle className="sr-only">Choose media</DialogTitle>
      <DialogDescription className="sr-only">Browse and upload supported media assets.</DialogDescription>
      <MediaWorkspace manager={manager} capability={capability} picker multiple={!!onSelectMultiple} onSelect={onSelect ? (file) => { onOpenChange(false); onSelect(file); } : undefined} onClose={() => onOpenChange(false)} />
    </DialogContent>
  );
}
