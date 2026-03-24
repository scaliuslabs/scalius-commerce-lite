import { type ReactNode, useRef, useEffect, useState, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, X } from "lucide-react";

interface DataTableToolbarProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder?: string;
  searchDebounceMs?: number;
  selectedCount?: number;
  bulkActions?: ReactNode;
  filters?: ReactNode;
  actions?: ReactNode;
}

export function DataTableToolbar({
  searchValue,
  onSearchChange,
  searchPlaceholder = "Search...",
  searchDebounceMs = 400,
  selectedCount = 0,
  bulkActions,
  filters,
  actions,
}: DataTableToolbarProps) {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [localSearch, setLocalSearch] = useState(searchValue);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks whether an immediate (non-debounced) change is in flight.
  // When true, the external sync effect should NOT overwrite localSearch
  // because the URL hasn't caught up yet.
  const pendingClearRef = useRef(false);

  // Debounced sync: when user types, wait `searchDebounceMs` then push to URL
  useEffect(() => {
    // If a clear was just dispatched immediately, skip debounce for that value
    if (pendingClearRef.current) return;

    debounceTimerRef.current = setTimeout(() => {
      if (localSearch !== searchValue) {
        onSearchChange(localSearch);
      }
    }, searchDebounceMs);

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [localSearch, searchDebounceMs, searchValue, onSearchChange]);

  // Sync from URL → local (e.g. back/forward navigation, external resets)
  // Only sync if we don't have a pending immediate change waiting for URL to catch up.
  useEffect(() => {
    if (pendingClearRef.current) {
      // The URL just caught up with our immediate change — allow future syncs
      if (searchValue === localSearch) {
        pendingClearRef.current = false;
      }
      return;
    }
    if (searchValue !== localSearch) {
      setLocalSearch(searchValue);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchValue]);

  // Keyboard shortcut: / to focus search, Escape to clear
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (
        e.key === "/" &&
        !["INPUT", "TEXTAREA", "SELECT"].includes(
          (e.target as HTMLElement).tagName,
        )
      ) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
      if (e.key === "Escape" && document.activeElement === searchInputRef.current) {
        clearSearchRef.current();
        searchInputRef.current?.blur();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearSearch = useCallback(() => {
    // Cancel any pending debounce
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    // Mark that we're doing an immediate change — prevents the external
    // sync effect from restoring the stale searchValue before URL updates.
    pendingClearRef.current = true;
    setLocalSearch("");
    onSearchChange("");
    searchInputRef.current?.focus();
  }, [onSearchChange]);

  // Keep a stable ref to clearSearch so the keydown handler always uses the latest
  const clearSearchRef = useRef(clearSearch);
  clearSearchRef.current = clearSearch;

  return (
    <div className="flex flex-col gap-3 pb-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-1 items-center gap-2">
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            placeholder={searchPlaceholder}
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
            className="h-9 pl-8 pr-8"
          />
          {localSearch && (
            <button
              type="button"
              onClick={clearSearch}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {filters}
      </div>
      <div className="flex items-center gap-2">
        {selectedCount > 0 && bulkActions}
        {actions}
      </div>
    </div>
  );
}
