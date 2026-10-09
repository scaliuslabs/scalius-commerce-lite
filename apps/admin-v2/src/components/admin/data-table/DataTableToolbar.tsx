import { type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ListFilter, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";
import { useColumnMenu } from "./DataTableColumnMenu";
import { matchesShortcut, typingIn } from "../layout/shortcuts";

/** The list search waits this long after the last key before it asks the server (X2). */
export const SEARCH_DEBOUNCE_MS = 300;

interface DataTableToolbarProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder?: string;
  searchDebounceMs?: number;
  /** While rows are selected, the bulk bar (`IndexBulkBar`) takes the toolbar's place. */
  bulkBar?: ReactNode;
  /** The list's filter fields, shown in a panel under the toolbar by the "Filters" button. */
  filters?: ReactNode;
  /** How many filters are set (the button says "Filters (2)"). */
  filterCount?: number;
  /** Clears every filter (the panel's "Clear filters"). */
  onClearFilters?: () => void;
  /** After the sort and columns menus: a list's own control (orders' "3 new orders"). */
  extra?: ReactNode;
}

/**
 * The one list toolbar (T2, Polaris IndexFilters): search, "Filters", the sort
 * menu and the columns menu, in that order on every list. The filter fields
 * open in a panel under it. While rows are selected, the bulk bar takes its
 * place at the same height, so the table under it never moves.
 */
export function DataTableToolbar({
  searchValue,
  onSearchChange,
  searchPlaceholder,
  searchDebounceMs = SEARCH_DEBOUNCE_MS,
  bulkBar,
  filters,
  filterCount = 0,
  onClearFilters,
  extra,
}: DataTableToolbarProps) {
  const t = useMessages(resourceMessages);
  // Sort and columns, from the table this toolbar sits on (Shopify: right of the search).
  const { sortMenu, columnMenu } = useColumnMenu();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [localSearch, setLocalSearch] = useState(searchValue);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const panelId = useId();

  // The last value this toolbar pushed: when the parent's value catches up
  // with it, that is our own change, not an outside one to copy back.
  const lastPushedRef = useRef(searchValue);

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

  // An outside change (a tab switch, "Clear filters"): show it.
  useEffect(() => {
    if (searchValue === lastPushedRef.current) return;
    setLocalSearch(searchValue);
    lastPushedRef.current = searchValue;
  }, [searchValue]);

  // `/` focuses the search, Escape clears it.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (matchesShortcut("tableSearch", e) && !typingIn(e.target)) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
      if (matchesShortcut("cancel", e) && document.activeElement === searchInputRef.current) {
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

  const bulk = Boolean(bulkBar);

  return (
    <>
      {bulkBar}
      <div data-bulk-hidden={bulk ? "" : undefined} className="px-2 py-2 data-[bulk-hidden]:hidden">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {/* Phones: the search has its own row, the buttons share the next (N5). */}
          <div className="relative min-w-[220px] flex-1 max-sm:basis-full">
            <Search className="absolute inset-s-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              placeholder={searchPlaceholder ?? t("search")}
              aria-label={searchPlaceholder ?? t("search")}
              value={localSearch}
              onChange={(e) => setLocalSearch(e.target.value)}
              // eslint-disable-next-line shadcn/no-restyle, shadcn/require-static-classes -- room for the inline search icon and, with text, the clear button
              className={localSearch ? "ps-8 pe-11 sm:pe-9" : "ps-8 pe-3"}
            />
            {localSearch && (
              <button
                type="button"
                onClick={clearSearch}
                aria-label={t("clearSearch")}
                title={t("clearSearch")}
                className="absolute inset-e-0 top-0 flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:w-9"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {filters ? (
            <Button
              type="button"
              variant="outline"
              aria-expanded={filtersOpen}
              aria-controls={panelId}
              onClick={() => setFiltersOpen((open) => !open)}
            >
              <ListFilter aria-hidden />
              {filterCount > 0 ? t("filtersCount", { count: filterCount }) : t("filters")}
            </Button>
          ) : null}
          {sortMenu}
          {columnMenu}
          {extra}
        </div>
        {filters && filtersOpen ? (
          <div id={panelId} role="group" aria-label={t("filters")} className="mt-2 space-y-3 border-t pt-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{filters}</div>
            {filterCount > 0 && onClearFilters ? (
              <div className="flex justify-end">
                <Button type="button" variant="ghost" onClick={onClearFilters}>
                  <X aria-hidden />
                  {t("clearFilters")}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}

/**
 * The bulk bar (T10): with rows selected it takes the toolbar's place and
 * sticks under the top bar while the list scrolls, so the actions stay in
 * reach on row 50. The table's header sticks under it (`--index-sticky-top`).
 * `status` is the selection ("3 selected", "All 1,000+ matching products")
 * with its "Select all" link; `actions` the buttons.
 */
export function IndexBulkBar({
  status,
  actions,
  onClear,
}: {
  status: ReactNode;
  actions: ReactNode;
  onClear: () => void;
}) {
  const t = useMessages(resourceMessages);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const bar = ref.current;
    const list = bar?.closest<HTMLElement>("[data-slot=index-table]");
    if (!bar || !list) return;
    const measure = () => list.style.setProperty("--index-sticky-top", `${bar.offsetHeight}px`);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(bar);
    return () => {
      observer?.disconnect();
      list.style.removeProperty("--index-sticky-top");
    };
  }, []);
  return (
    <div
      ref={ref}
      data-slot="bulk-bar"
      role="toolbar"
      aria-label={t("bulkActions")}
      className="sticky top-0 z-30 flex items-center gap-2 border-b bg-card px-2 py-2"
    >
      <div className="flex shrink-0 items-center gap-1 text-body font-medium">{status}</div>
      <div className="scrollbar-hide flex min-w-0 flex-1 flex-nowrap items-center gap-2 overflow-x-auto whitespace-nowrap">
        {actions}
      </div>
      <Button type="button" variant="ghost" size="icon" className="shrink-0" aria-label={t("clearSelection")} title={t("clearSelection")} onClick={onClear}>
        <X aria-hidden />
      </Button>
    </div>
  );
}
