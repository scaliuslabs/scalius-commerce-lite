import { useEffect, useRef, useState } from "react";
import { FolderInput, RotateCcw, Search, Trash2, Upload } from "lucide-react";
import { Button } from "~/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";
import { useMessages } from "~/i18n";
import { mediaMessages } from "~/i18n/media";
import { resourceMessages } from "~/i18n/resource";
import type { MediaCapability, MediaFilterOptions, MediaFolder, MediaLibraryView } from "../types";
import { MEDIA_SORTS, type MediaSortKey } from "../route-state";
import { FolderBrowser } from "./FolderBrowser";

interface MediaFilterBarProps {
  capability: MediaCapability;
  filters: MediaFilterOptions;
  view: MediaLibraryView;
  selectedCount: number;
  selectableCount: number;
  selectionMode: boolean;
  folders: MediaFolder[];
  currentFolderId: string | null | "all";
  isMutating: boolean;
  allowSelection?: boolean;
  allowManagement: boolean;
  onSearch: (value: string) => void;
  onFiltersChange: (updates: Partial<MediaFilterOptions>) => void;
  /** Opens the file chooser; omitted where uploads don't apply (Trash). */
  onUploadClick?: () => void;
  onFolderSelect: (id: string | null | "all") => void;
  onFolderCreate: (name: string) => Promise<MediaFolder>;
  onFolderRename: (folder: MediaFolder, name: string) => Promise<void>;
  onFolderDelete: (folder: MediaFolder) => Promise<void>;
  onBeginSelection: () => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onCancelSelection?: () => void;
  onMove: (folderId: string | null) => void;
  onLifecycle: (action: "trash" | "restore" | "permanent") => void;
}

const SORT_LABELS: Record<MediaSortKey, "sortNewest" | "sortOldest" | "sortLargest" | "sortSmallest" | "sortNameAsc" | "sortNameDesc"> = {
  newest: "sortNewest",
  oldest: "sortOldest",
  largest: "sortLargest",
  smallest: "sortSmallest",
  "name-asc": "sortNameAsc",
  "name-desc": "sortNameDesc",
};

/** Search, folder, type, sort, Select and Upload in one row; the bulk bar below it while selecting. */
export function MediaFilterBar(props: MediaFilterBarProps) {
  const t = useMessages(mediaMessages);
  const r = useMessages(resourceMessages);
  const selectTriggerRef = useRef<HTMLButtonElement>(null);
  const wasSelectingRef = useRef(props.selectionMode);
  const [search, setSearch] = useState(props.filters.search);
  const sortValue = (Object.entries(MEDIA_SORTS).find(([, value]) => value[0] === props.filters.sortBy && value[1] === props.filters.sortOrder)?.[0] ?? "newest") as MediaSortKey;
  const selecting = props.allowSelection !== false && props.selectionMode;
  const canAct = props.allowManagement && props.selectedCount > 0;

  useEffect(() => {
    setSearch(props.filters.search);
  }, [props.filters.search]);

  useEffect(() => {
    if (wasSelectingRef.current && !props.selectionMode) selectTriggerRef.current?.focus();
    wasSelectingRef.current = props.selectionMode;
  }, [props.selectionMode]);

  return (
    <div className="border-b">
      <div className="flex flex-wrap items-center gap-2 p-2">
        <div className="relative min-w-48 flex-1 basis-56">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            aria-label={t("searchFiles")}
            placeholder={t("searchFiles")}
            value={search}
            // eslint-disable-next-line shadcn/no-restyle -- room for the inline search icon
            className="pl-8"
            onChange={(event) => {
              setSearch(event.target.value);
              props.onSearch(event.target.value);
            }}
          />
        </div>
        <FolderBrowser
          folders={props.folders}
          currentFolderId={props.currentFolderId}
          onFolderSelect={props.onFolderSelect}
          onFolderCreate={props.onFolderCreate}
          onFolderRename={props.onFolderRename}
          onFolderDelete={props.onFolderDelete}
        />
        {props.capability === "both" ? (
          <NativeSelect
            aria-label={t("fileType")}
            className="w-32"
            value={props.filters.kind ?? "all"}
            onValueChange={(value) => props.onFiltersChange({ kind: value === "all" ? undefined : (value as "image" | "video") })}
          >
            <option value="all">{t("allTypes")}</option>
            <option value="image">{t("images")}</option>
            <option value="video">{t("videos")}</option>
          </NativeSelect>
        ) : null}
        <NativeSelect
          aria-label={t("sortBy")}
          className="w-32"
          value={sortValue}
          onValueChange={(value) => {
            const [sortBy, sortOrder] = MEDIA_SORTS[value as MediaSortKey];
            props.onFiltersChange({ sortBy, sortOrder });
          }}
        >
          {(Object.keys(SORT_LABELS) as MediaSortKey[]).map((key) => (
            <option key={key} value={key}>{t(SORT_LABELS[key])}</option>
          ))}
        </NativeSelect>
        {props.allowSelection !== false && !props.selectionMode ? (
          <Button ref={selectTriggerRef} type="button" variant="outline" onClick={props.onBeginSelection}>
            {t("select")}
          </Button>
        ) : null}
        {props.onUploadClick ? (
          <Button type="button" variant={props.allowManagement ? "default" : "outline"} onClick={props.onUploadClick}>
            <Upload aria-hidden="true" />
            {t("upload")}
          </Button>
        ) : null}
      </div>

      {selecting ? (
        <div
          role="toolbar"
          aria-label={t("bulkActions")}
          aria-busy={props.isMutating || undefined}
          className="flex flex-wrap items-center gap-2 border-t bg-muted px-3 py-1.5"
        >
          <span className="mr-auto text-body font-medium tabular-nums" aria-live="polite" aria-atomic="true">
            {r("selected", { count: props.selectedCount })}
          </span>
          {props.selectableCount > 0 && props.selectedCount < props.selectableCount ? (
            <Button type="button" variant="ghost" size="sm" onClick={props.onSelectAll}>{t("selectAllShown")}</Button>
          ) : null}
          {props.selectedCount > 0 ? (
            <Button type="button" variant="ghost" size="sm" onClick={props.onClearSelection}>{r("clearSelection")}</Button>
          ) : null}
          {canAct && props.view === "ready" ? (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" size="sm" disabled={props.isMutating}>
                    <FolderInput aria-hidden="true" />
                    {t("moveToFolder")}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => props.onMove(null)}>{t("unfiled")}</DropdownMenuItem>
                  {props.folders.map((folder) => (
                    <DropdownMenuItem key={folder.id} onSelect={() => props.onMove(folder.id)}>{folder.name}</DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button type="button" variant="outline" size="sm" disabled={props.isMutating} onClick={() => props.onLifecycle("trash")}>
                <Trash2 aria-hidden="true" />
                {r("moveToTrash")}
              </Button>
            </>
          ) : null}
          {canAct && props.view === "trash" ? (
            <>
              <Button type="button" variant="outline" size="sm" disabled={props.isMutating} onClick={() => props.onLifecycle("restore")}>
                <RotateCcw aria-hidden="true" />
                {r("restore")}
              </Button>
              <Button type="button" variant="destructive" size="sm" disabled={props.isMutating} onClick={() => props.onLifecycle("permanent")}>
                {r("deletePermanently")}
              </Button>
            </>
          ) : null}
          {props.onCancelSelection ? (
            <Button type="button" variant="ghost" size="sm" onClick={props.onCancelSelection}>{r("cancel")}</Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
