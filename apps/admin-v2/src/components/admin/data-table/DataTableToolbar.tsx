import { type ReactNode, useRef, useEffect, useState, useCallback } from "react";
import { Input } from "@/components/ui/input";
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

  // Track the last value WE pushed to the parent (via debounce or clear).
  // When searchValue changes to this value, it means the URL caught up with
  // our own action — NOT an external change. We should NOT overwrite localSearch.
  const lastPushedRef = useRef(searchValue);

  // Debounced push: after user stops typing, push localSearch to URL
  useEffect(() => {
    debounceTimerRef.current = setTimeout(() => {
      if (localSearch !== searchValue) {
        lastPushedRef.current = localSearch;
        onSearchChange(localSearch);
      }
    }, searchDebounceMs);

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [localSearch, searchDebounceMs, searchValue, onSearchChange]);

  // Sync external URL changes → local (back/forward navigation, external resets)
  // Only sync if the new searchValue is NOT something we ourselves pushed.
  useEffect(() => {
    if (searchValue === lastPushedRef.current) {
      // URL caught up with our own push — no action needed
      return;
    }
    // External change (browser back/forward, Link navigation, etc.)
    setLocalSearch(searchValue);
    lastPushedRef.current = searchValue;
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
  }, []);

  const clearSearch = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    lastPushedRef.current = "";
    setLocalSearch("");
    onSearchChange("");
    searchInputRef.current?.focus();
  }, [onSearchChange]);

  const clearSearchRef = useRef(clearSearch);
  clearSearchRef.current = clearSearch;

  return (
    <div className="flex flex-col gap-2 pb-2 sm:flex-row sm:items-center sm:justify-between">
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
