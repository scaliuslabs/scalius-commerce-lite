import { type ReactNode, useRef, useEffect, useState, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, X } from "lucide-react";
import { useDebounce } from "@/hooks/use-debounce";

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
  const debouncedSearch = useDebounce(localSearch, searchDebounceMs);

  // Sync debounced value to parent
  useEffect(() => {
    if (debouncedSearch !== searchValue) {
      onSearchChange(debouncedSearch);
    }
  }, [debouncedSearch, searchValue, onSearchChange]);

  // Sync external value changes (e.g., URL navigation)
  useEffect(() => {
    setLocalSearch(searchValue);
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
        setLocalSearch("");
        onSearchChange("");
        searchInputRef.current?.blur();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onSearchChange]);

  const clearSearch = useCallback(() => {
    setLocalSearch("");
    onSearchChange("");
    searchInputRef.current?.focus();
  }, [onSearchChange]);

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
