import { useState } from "react";
import { FolderPlus, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { useMessages } from "~/i18n";
import { mediaMessages } from "~/i18n/media";
import { resourceMessages } from "~/i18n/resource";
import type { MediaFolder } from "../types";

interface FolderBrowserProps {
  folders: MediaFolder[];
  currentFolderId: string | null | "all";
  onFolderSelect: (id: string | null | "all") => void;
  onFolderCreate: (name: string) => Promise<MediaFolder>;
  onFolderRename: (folder: MediaFolder, name: string) => Promise<void>;
  onFolderDelete: (folder: MediaFolder) => Promise<void>;
}

/** Folder filter for the files toolbar, with new/rename/delete in a menu. Folders are one level deep. */
export function FolderBrowser({ folders, currentFolderId, onFolderSelect, onFolderCreate, onFolderRename, onFolderDelete }: FolderBrowserProps) {
  const t = useMessages(mediaMessages);
  const r = useMessages(resourceMessages);
  const [dialog, setDialog] = useState<{ mode: "create" } | { mode: "rename"; folder: MediaFolder } | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleteFolder, setDeleteFolder] = useState<MediaFolder | null>(null);
  const current = folders.find((folder) => folder.id === currentFolderId);
  const value = currentFolderId === "all" ? "all" : currentFolderId === null ? "unfiled" : currentFolderId;

  const open = (next: NonNullable<typeof dialog>) => {
    setDialog(next);
    setName(next.mode === "rename" ? next.folder.name : "");
  };
  const save = async () => {
    const value = name.trim();
    if (!dialog || !value || busy) return;
    setBusy(true);
    try {
      if (dialog.mode === "create") await onFolderCreate(value);
      else await onFolderRename(dialog.folder, value);
      setDialog(null);
    } catch {
      // The folder hook shows the error; keep the dialog and the typed name.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-1">
      <Select value={value} onValueChange={(next) => onFolderSelect(next === "all" ? "all" : next === "unfiled" ? null : next)}>
        <SelectTrigger aria-label={t("folder")} className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("allFolders")}</SelectItem>
          <SelectItem value="unfiled">{t("unfiled")}</SelectItem>
          {folders.map((folder) => (
            <SelectItem key={folder.id} value={folder.id}>{folder.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon" aria-label={t("folderActions")}>
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => open({ mode: "create" })}>
            <FolderPlus aria-hidden="true" />
            {t("newFolder")}
          </DropdownMenuItem>
          {current ? (
            <>
              <DropdownMenuItem onSelect={() => open({ mode: "rename", folder: current })}>
                <Pencil aria-hidden="true" />
                {t("renameFolder")}
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => setDeleteFolder(current)}>
                <Trash2 aria-hidden="true" />
                {t("deleteFolder")}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={dialog !== null} onOpenChange={(next) => !next && !busy && setDialog(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t(dialog?.mode === "rename" ? "renameFolder" : "newFolder")}</DialogTitle>
            <DialogDescription>{t("folderHelp")}</DialogDescription>
          </DialogHeader>
          <form
            method="post"
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              // The picker can open inside another form; keep this submit to itself.
              event.preventDefault();
              event.stopPropagation();
              void save();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="media-folder-name">{t("folderName")}</Label>
              <Input id="media-folder-name" value={name} maxLength={100} autoFocus onChange={(event) => setName(event.target.value)} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setDialog(null)}>{r("cancel")}</Button>
              <Button type="submit" loading={busy} disabled={!name.trim()}>
                {dialog?.mode === "rename" ? r("save") : t("createFolder")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={deleteFolder !== null}
        onOpenChange={(next) => !next && setDeleteFolder(null)}
        title={t("deleteFolderTitle", { name: deleteFolder?.name ?? "" })}
        description={t("deleteFolderBody")}
        confirmLabel={t("deleteFolder")}
        cancelLabel={r("cancel")}
        onConfirm={() => {
          if (deleteFolder) void onFolderDelete(deleteFolder);
          setDeleteFolder(null);
        }}
      />
    </div>
  );
}
