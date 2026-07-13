import { useState } from "react";
import { Folder, FolderOpen, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { Button } from "~/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "~/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import type { MediaFolder } from "../types";

interface FolderBrowserProps {
  folders: MediaFolder[];
  currentFolderId: string | null | "all";
  onFolderSelect: (id: string | null | "all") => void;
  onFolderCreate: (name: string) => Promise<MediaFolder>;
  onFolderRename: (folder: MediaFolder, name: string) => Promise<void>;
  onFolderDelete: (folder: MediaFolder) => Promise<void>;
}

export function FolderBrowser({ folders, currentFolderId, onFolderSelect, onFolderCreate, onFolderRename, onFolderDelete }: FolderBrowserProps) {
  const [dialog, setDialog] = useState<{ mode: "create" } | { mode: "rename"; folder: MediaFolder } | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleteFolder, setDeleteFolder] = useState<MediaFolder | null>(null);

  const open = (next: typeof dialog) => {
    setDialog(next);
    setName(next?.mode === "rename" ? next.folder.name : "");
  };
  const save = async () => {
    const value = name.trim();
    if (!dialog || !value) return;
    setBusy(true);
    try {
      if (dialog.mode === "create") await onFolderCreate(value);
      else await onFolderRename(dialog.folder, value);
      setDialog(null);
    } finally { setBusy(false); }
  };

  const row = (id: string | null | "all", label: string, icon: React.ReactNode, actions?: React.ReactNode) => (
    <div className="group flex items-center gap-0.5" key={String(id)}>
      <button type="button" onClick={() => onFolderSelect(id)} className={cn("flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring", currentFolderId === id && "bg-muted font-medium")}>{icon}<span className="truncate">{label}</span></button>
      {actions}
    </div>
  );

  return (
    <>
      <aside className="flex min-h-0 w-full shrink-0 flex-col border-b bg-muted/15 md:w-48 md:border-b-0 md:border-r">
        <div className="flex h-10 items-center justify-between border-b px-3">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Folders</span>
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => open({ mode: "create" })} aria-label="Create folder"><Plus className="h-3.5 w-3.5" /></Button>
        </div>
        <ScrollArea className="max-h-36 flex-1 md:max-h-none">
          <nav aria-label="Media folders" className="space-y-0.5 p-2">
            {row("all", "All assets", <FolderOpen className="h-3.5 w-3.5 shrink-0" />)}
            {row(null, "Unfiled", <Folder className="h-3.5 w-3.5 shrink-0" />)}
            {folders.map((folder) => row(folder.id, folder.name, <Folder className="h-3.5 w-3.5 shrink-0" />, (
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground" aria-label={`Actions for ${folder.name}`}><MoreHorizontal className="h-3.5 w-3.5" /></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => open({ mode: "rename", folder })}><Pencil className="mr-2 h-3.5 w-3.5" />Rename</DropdownMenuItem>
                  <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setDeleteFolder(folder)}><Trash2 className="mr-2 h-3.5 w-3.5" />Delete</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )))}
          </nav>
        </ScrollArea>
      </aside>

      <Dialog open={!!dialog} onOpenChange={(value) => !value && setDialog(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>{dialog?.mode === "rename" ? "Rename folder" : "Create folder"}</DialogTitle><DialogDescription>Folders are flat and only organize this library.</DialogDescription></DialogHeader>
          <Input value={name} maxLength={100} autoFocus placeholder="Folder name" onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void save(); }} />
          <DialogFooter><Button type="button" variant="outline" onClick={() => setDialog(null)}>Cancel</Button><Button type="button" disabled={!name.trim() || busy} onClick={() => void save()}>{dialog?.mode === "rename" ? "Save name" : "Create folder"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={!!deleteFolder} onOpenChange={(value) => !value && setDeleteFolder(null)}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete {deleteFolder?.name}?</AlertDialogTitle><AlertDialogDescription>Only empty folders can be deleted. Assets are never deleted with a folder.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Keep folder</AlertDialogCancel><AlertDialogAction onClick={() => { if (deleteFolder) void onFolderDelete(deleteFolder); setDeleteFolder(null); }}>Delete folder</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
    </>
  );
}
