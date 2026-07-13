import { useEffect, useState } from "react";
import { Upload } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "~/components/ui/dialog";
import { MediaWorkspace } from "./MediaWorkspace";
import { useMediaManager } from "./hooks/useMediaManager";
import type { MediaManagerProps } from "./types";

type MediaManagerInternalProps = MediaManagerProps & { initialOpen?: boolean; onInitialOpenHandled?: () => void };

export function MediaManager({
  onSelect,
  onSelectMultiple,
  selectedFiles = [],
  triggerLabel = "Select image",
  trigger,
  capability = "image",
  dialogClassName,
  initialOpen = false,
  onInitialOpenHandled,
}: MediaManagerInternalProps) {
  const [open, setOpen] = useState(initialOpen);
  const manager = useMediaManager({
    autoLoad: false,
    capability,
    onSelect: onSelect ? (file) => { onSelect(file); setOpen(false); } : undefined,
    onSelectMultiple: onSelectMultiple ? (files) => { onSelectMultiple(files); setOpen(false); } : undefined,
  });

  useEffect(() => {
    if (!initialOpen) return;
    setOpen(true);
    onInitialOpenHandled?.();
  }, [initialOpen, onInitialOpenHandled]);

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
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger ?? <Button type="button" variant="outline" className="w-full"><Upload className="mr-2 h-4 w-4" />{triggerLabel}</Button>}</DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className={`h-[94svh] max-h-[860px] w-[96vw] max-w-7xl overflow-hidden p-0 ${dialogClassName ?? ""}`}
      >
        <DialogTitle className="sr-only">Choose media</DialogTitle>
        <DialogDescription className="sr-only">Browse and upload supported media assets.</DialogDescription>
        <MediaWorkspace manager={manager} capability={capability} picker multiple={!!onSelectMultiple} onSelect={onSelect ? (file) => { onSelect(file); setOpen(false); } : undefined} onClose={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
