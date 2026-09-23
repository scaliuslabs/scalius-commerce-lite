import { useEffect } from "react";
import { cn } from "@scalius/shared/utils";
import { DialogContent, DialogDescription, DialogTitle } from "~/components/ui/dialog";
import { useMessages } from "~/i18n";
import { mediaMessages } from "~/i18n/media";
import { MediaWorkspace } from "./MediaWorkspace";
import { useMediaManager } from "./hooks/useMediaManager";
import { mediaLimitKey, type MediaManagerProps } from "./types";

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
  const t = useMessages(mediaMessages);
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
    // eslint-disable-next-line shadcn/require-static-classes -- callers add layout only (z-index over the fullscreen editor)
    <DialogContent className={cn("flex h-[94svh] max-h-[860px] w-full flex-col gap-0 overflow-hidden p-0 sm:w-[96vw] sm:max-w-6xl", dialogClassName)}>
      <div className="flex flex-col gap-1 border-b py-3 pl-4 pr-14">
        <DialogTitle>{t(capability === "image" ? "chooseImage" : capability === "video" ? "chooseVideo" : "chooseFile")}</DialogTitle>
        <DialogDescription>{t(mediaLimitKey(capability))}</DialogDescription>
      </div>
      <MediaWorkspace manager={manager} capability={capability} picker multiple={!!onSelectMultiple} onSelect={onSelect ? (file) => { onOpenChange(false); onSelect(file); } : undefined} onClose={() => onOpenChange(false)} />
    </DialogContent>
  );
}
