import { useEffect, useRef, useState } from "react";
import { CheckSquare2, FolderInput, RotateCcw, Search, Trash2, Upload, X } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { capabilityAccept, type MediaCapability, type MediaFilterOptions, type MediaFolder, type MediaLibraryView } from "../types";

const SORTS = {
  newest: ["createdAt", "desc"],
  oldest: ["createdAt", "asc"],
  largest: ["size", "desc"],
  smallest: ["size", "asc"],
  "name-asc": ["filename", "asc"],
  "name-desc": ["filename", "desc"],
} as const satisfies Record<string, readonly [MediaFilterOptions["sortBy"], MediaFilterOptions["sortOrder"]]>;

interface MediaFilterBarProps {
  capability: MediaCapability;
  filters: MediaFilterOptions;
  view: MediaLibraryView;
  selectedCount: number;
  visibleCount: number;
  selectionMode: boolean;
  folders: MediaFolder[];
  isMutating: boolean;
  allowSelection?: boolean;
  onSearch: (value: string) => void;
  onFiltersChange: (updates: Partial<MediaFilterOptions>) => void;
  onUpload: (files: FileList | null) => Promise<void>;
  onBeginSelection: () => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onCancelSelection?: () => void;
  onMove: (folderId: string | null) => void;
  onLifecycle: (action: "trash" | "restore" | "permanent") => void;
  onAddSelected?: () => void;
}

export function MediaFilterBar(props: MediaFilterBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const selectTriggerRef = useRef<HTMLButtonElement>(null);
  const wasSelectingRef = useRef(props.selectionMode);
  const [search, setSearch] = useState(props.filters.search);
  const [targetFolder, setTargetFolder] = useState("");
  const sortValue = Object.entries(SORTS).find(([, value]) => value[0] === props.filters.sortBy && value[1] === props.filters.sortOrder)?.[0] ?? "newest";

  useEffect(() => {
    if (props.selectedCount === 0) setTargetFolder("");
  }, [props.selectedCount]);

  useEffect(() => {
    if (wasSelectingRef.current && !props.selectionMode) {
      selectTriggerRef.current?.focus();
    }
    wasSelectingRef.current = props.selectionMode;
  }, [props.selectionMode]);

  return (
    <div className="border-b bg-background px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        {props.view === "ready" && (
          <>
            <input ref={inputRef} className="sr-only" type="file" multiple accept={capabilityAccept(props.capability)} onChange={(event) => { void props.onUpload(event.target.files); event.currentTarget.value = ""; }} />
            <Button type="button" size="sm" className="h-8" onClick={() => inputRef.current?.click()}><Upload className="mr-1.5 h-3.5 w-3.5" />Upload</Button>
          </>
        )}
        <div className="relative min-w-44 flex-1 basis-52 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input className="h-8 pl-8 text-[13px]" value={search} placeholder="Search assets" onChange={(event) => { setSearch(event.target.value); props.onSearch(event.target.value); }} />
        </div>
        {props.capability === "both" && (
          <Select value={props.filters.kind ?? "all"} onValueChange={(value) => props.onFiltersChange({ kind: value === "all" ? undefined : value as "image" | "video" })}>
            <SelectTrigger className="h-8 w-28 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All types</SelectItem><SelectItem value="image">Images</SelectItem><SelectItem value="video">Videos</SelectItem></SelectContent>
          </Select>
        )}
        <Select value={sortValue} onValueChange={(value) => { const sort = SORTS[value as keyof typeof SORTS]; props.onFiltersChange({ sortBy: sort[0], sortOrder: sort[1] }); }}>
          <SelectTrigger className="h-8 w-28 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="newest">Newest</SelectItem><SelectItem value="oldest">Oldest</SelectItem><SelectItem value="largest">Largest</SelectItem><SelectItem value="smallest">Smallest</SelectItem><SelectItem value="name-asc">Name A–Z</SelectItem><SelectItem value="name-desc">Name Z–A</SelectItem></SelectContent>
        </Select>

        {!props.selectionMode && <span className="ml-auto text-xs tabular-nums text-muted-foreground">{props.visibleCount} shown</span>}
        {props.allowSelection !== false && !props.selectionMode && <Button ref={selectTriggerRef} type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={props.onBeginSelection}>Select</Button>}
      </div>

      {props.allowSelection !== false && props.selectionMode && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-md border bg-muted/35 p-1.5" role="toolbar" aria-label="Selected asset actions" aria-busy={props.isMutating || undefined}>
          <div className="mr-auto flex min-h-7 items-center gap-2 px-1.5 text-xs" aria-live="polite" aria-atomic="true">
            <CheckSquare2 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            <span className="font-medium tabular-nums">{props.selectedCount} selected</span>
            <span className="hidden text-muted-foreground sm:inline">Shift-click for a range{props.onCancelSelection ? " · Esc to cancel" : ""}</span>
          </div>

          {props.visibleCount > 0 && props.selectedCount < props.visibleCount && <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={props.onSelectAll}>Select all shown</Button>}
          {props.selectedCount > 0 && <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={props.onClearSelection}><X className="mr-1 h-3.5 w-3.5" />Clear</Button>}
          {props.onCancelSelection && <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={props.onCancelSelection}>Cancel</Button>}

          {props.selectedCount > 0 && props.view === "ready" && (
            <>
              <div className="flex items-center">
                <Select value={targetFolder} onValueChange={setTargetFolder}>
                  <SelectTrigger className="h-7 w-32 rounded-r-none text-xs"><SelectValue placeholder="Move to folder" /></SelectTrigger>
                  <SelectContent><SelectItem value="root">Unfiled</SelectItem>{props.folders.map((folder) => <SelectItem value={folder.id} key={folder.id}>{folder.name}</SelectItem>)}</SelectContent>
                </Select>
                <Button type="button" variant="outline" size="icon" className="h-7 w-7 rounded-l-none border-l-0" disabled={!targetFolder || props.isMutating} onClick={() => props.onMove(targetFolder === "root" ? null : targetFolder)} aria-label="Move selected assets"><FolderInput className="h-3.5 w-3.5" /></Button>
              </div>
              <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={props.isMutating} onClick={() => props.onLifecycle("trash")}><Trash2 className="mr-1 h-3.5 w-3.5" />Trash</Button>
            </>
          )}
          {props.selectedCount > 0 && props.view === "trash" && (
            <>
              <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={props.isMutating} onClick={() => props.onLifecycle("restore")}><RotateCcw className="mr-1 h-3.5 w-3.5" />Restore</Button>
              <Button type="button" variant="destructive" size="sm" className="h-7 px-2 text-xs" disabled={props.isMutating} onClick={() => props.onLifecycle("permanent")}><Trash2 className="mr-1 h-3.5 w-3.5" />Delete</Button>
            </>
          )}
          {props.onAddSelected && <Button type="button" size="sm" className="h-7 px-2.5 text-xs" disabled={!props.selectedCount || props.isMutating} onClick={props.onAddSelected}>Add {props.selectedCount}</Button>}
        </div>
      )}
    </div>
  );
}
