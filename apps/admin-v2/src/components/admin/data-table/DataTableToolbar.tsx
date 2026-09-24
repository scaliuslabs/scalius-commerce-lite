import { type ReactNode, useRef, useEffect, useState, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Search, X } from "lucide-react";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";
import { useColumnMenu } from "./DataTableColumnMenu";

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
  searchPlaceholder,
  searchDebounceMs = 400,
  selectedCount = 0,
  bulkActions,
  filters,
  actions,
}: DataTableToolbarProps) {
  const t = useMessages(resourceMessages);
  // Sort and columns, from the table this toolbar sits on (Shopify: right of the search).
  const columnMenu = useColumnMenu();
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

  // Shopify's index table: while rows are selected the bulk bar takes the
  // search row's place at the same height, so the table under it never moves.
  const bulk = selectedCount > 0 && bulkActions;

  return (
    <div className="flex flex-col gap-2 pb-2 sm:flex-row sm:items-start sm:justify-between">
      {bulk ? (
        <div
          data-slot="bulk-bar"
          role="toolbar"
          aria-label={t("bulkActions")}
          className="scrollbar-hide flex min-h-11 min-w-0 flex-1 flex-nowrap items-center gap-2 overflow-x-auto whitespace-nowrap sm:min-h-9"
        >
          {bulkActions}
        </div>
      ) : null}
      <div data-bulk-hidden={bulk ? "" : undefined} className="flex min-w-0 flex-1 flex-wrap items-center gap-2 data-[bulk-hidden]:hidden">
        <div className="relative min-w-[220px] max-w-sm flex-1">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            placeholder={searchPlaceholder ?? t("search")}
            aria-label={searchPlaceholder ?? t("search")}
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
            // eslint-disable-next-line shadcn/no-restyle -- room for the inline search icon and clear button
            className="pl-8 pr-11 sm:pr-9"
          />
          {localSearch && (
            <button
              type="button"
              onClick={clearSearch}
              aria-label={t("clearSearch")}
              className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center text-muted-foreground hover:text-foreground sm:h-9 sm:w-9"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {filters}
        {columnMenu}
      </div>
      {actions ? <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
