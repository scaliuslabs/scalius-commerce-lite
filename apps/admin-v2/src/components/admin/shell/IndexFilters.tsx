import { Search, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";

import { cn } from "@scalius/shared/utils";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

export interface IndexFilterPill {
  id: string;
  label: string;
  /** Optional result count shown next to the label. */
  count?: number;
}

export interface IndexSortOption {
  value: string;
  label: string;
}

export interface IndexFiltersProps {
  /** Accessible name for the filter bar. Default: "Filters". */
  label?: string;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  /** Default: "Search". */
  searchPlaceholder?: string;
  /**
   * Wait this long after the last keystroke before reporting the search. `0`
   * (the default) reports every keystroke; use a delay only when the search
   * costs a request or a URL change. The field itself stays responsive either
   * way, and clearing always reports immediately.
   */
  searchDebounceMs?: number;
  /** Saved views / status pills. The active one is `activeFilterId`. */
  filters?: readonly IndexFilterPill[];
  activeFilterId?: string;
  onFilterChange?: (id: string) => void;
  sortOptions?: readonly IndexSortOption[];
  sortValue?: string;
  onSortChange?: (value: string) => void;
  /** Extra controls on the right (a date range, a column picker). */
  actions?: ReactNode;
  className?: string;
}

/**
 * Filter bar above an `IndexTable`: search, filter pills, and a sort select.
 * Every control is optional — render only what the list actually supports.
 */
export function IndexFilters({
  label = "Filters",
  searchValue,
  onSearchChange,
  searchPlaceholder = "Search",
  searchDebounceMs = 0,
  filters,
  activeFilterId,
  onFilterChange,
  sortOptions,
  sortValue,
  onSortChange,
  actions,
  className,
}: IndexFiltersProps) {
  const searchId = useId();
  const sortId = useId();
  const hasSearch = typeof onSearchChange === "function";
  const hasSort = Boolean(sortOptions && sortOptions.length > 0 && onSortChange);

  const committedValue = searchValue ?? "";
  // What the field shows. It leads the committed value while a debounce is
  // pending, so typing never stutters and the clear button appears at once.
  const [draft, setDraft] = useState(committedValue);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastReported = useRef(committedValue);

  function cancelPendingSearch() {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
  }

  // Adopt a value the caller changed itself (a cleared filter, a deep link)
  // without overwriting keystrokes the caller has not seen yet.
  useEffect(() => {
    if (committedValue === lastReported.current) return;
    lastReported.current = committedValue;
    cancelPendingSearch();
    setDraft(committedValue);
  }, [committedValue]);

  useEffect(() => cancelPendingSearch, []);

  function report(value: string) {
    lastReported.current = value;
    onSearchChange?.(value);
  }

  function changeSearch(value: string) {
    setDraft(value);
    cancelPendingSearch();
    if (searchDebounceMs <= 0) {
      report(value);
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      report(value);
    }, searchDebounceMs);
  }

  function clearSearch() {
    setDraft("");
    cancelPendingSearch();
    report("");
  }

  return (
    <div
      role="search"
      aria-label={label}
      data-testid="index-filters"
      className={cn("flex flex-col gap-3", className)}
    >
      {hasSearch || hasSort || actions ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {hasSearch ? (
            <div className="relative min-w-0 flex-1">
              <label htmlFor={searchId} className="sr-only">
                {searchPlaceholder}
              </label>
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                id={searchId}
                type="search"
                value={draft}
                placeholder={searchPlaceholder}
                data-testid="index-filters-search"
                className="min-h-11 pl-9 pr-9 sm:min-h-9"
                onChange={(event) => changeSearch(event.target.value)}
              />
              {draft ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Clear search"
                  className="absolute right-1 top-1/2 h-8 w-8 -translate-y-1/2"
                  onClick={clearSearch}
                >
                  <X className="h-4 w-4" aria-hidden />
                </Button>
              ) : null}
            </div>
          ) : null}

          {hasSort ? (
            <div className="flex items-center gap-2">
              <label htmlFor={sortId} className="sr-only">
                Sort by
              </label>
              <Select value={sortValue} onValueChange={(value) => onSortChange?.(value)}>
                <SelectTrigger
                  id={sortId}
                  aria-label="Sort by"
                  data-testid="index-filters-sort"
                  className="min-h-11 w-full sm:min-h-9 sm:w-48"
                >
                  <SelectValue placeholder="Sort by" />
                </SelectTrigger>
                <SelectContent>
                  {sortOptions?.map((option) => (
                    <SelectItem key={option.value} value={option.value} className="min-h-11 sm:min-h-9">
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}

      {filters && filters.length > 0 ? (
        <div
          role="group"
          aria-label="Filter by status"
          className="-mx-1 flex flex-wrap items-center gap-1 px-1"
        >
          {filters.map((pill) => {
            const active = pill.id === activeFilterId;
            return (
              <button
                key={pill.id}
                type="button"
                aria-pressed={active}
                data-testid={`index-filters-pill-${pill.id}`}
                className={cn(
                  "inline-flex min-h-9 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "border-border bg-muted text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
                onClick={() => onFilterChange?.(pill.id)}
              >
                {pill.label}
                {typeof pill.count === "number" ? (
                  <span className="text-muted-foreground">{pill.count}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export default IndexFilters;
