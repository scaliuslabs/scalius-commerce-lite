import * as React from "react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Loader2, Search, X } from "lucide-react";

import { cn } from "@scalius/shared/utils";
import { useDebounce } from "~/hooks/use-debounce";
import { useMessages } from "~/i18n";
import { comboboxMessages } from "~/i18n/combobox";
import { fieldClassName } from "./input";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

export interface SearchableSelectOption {
  value: string;
  label: string;
  /** Muted text after the label, e.g. a place's parents ("Mirpur-2 · Dhaka"). */
  description?: string;
  /** Options with the same group sit under one heading, in the order given. */
  group?: string;
  keywords?: string[];
  disabled?: boolean;
}

/** One page of a server-searched list. */
export interface SearchableSelectPage {
  options: SearchableSelectOption[];
  hasMore: boolean;
}

/**
 * Loads one page for the typed search (already trimmed and debounced; never
 * put it in a page URL). Pages start at 1.
 */
export type SearchableSelectLoader = (request: {
  search: string;
  page: number;
  signal: AbortSignal;
}) => Promise<SearchableSelectPage>;

interface CommonProps {
  value?: string;
  /** `option` is null when the choice is cleared. */
  onValueChange: (value: string, option: SearchableSelectOption | null) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  ariaLabel?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  /** Width and layout of the field (it is a block of its own). */
  triggerClassName?: string;
  /** Shows an × that clears the choice (`onValueChange("", null)`). */
  clearable?: boolean;
  /** The chosen option's label while its page is not loaded (async lists). */
  selectedLabel?: string;
  /** The field is waiting for something else (e.g. its parent's list). */
  busy?: boolean;
  triggerRef?: React.Ref<HTMLButtonElement>;
  onBlur?: React.FocusEventHandler<HTMLButtonElement>;
  onFocus?: React.FocusEventHandler<HTMLButtonElement>;
  onOpenChange?: (open: boolean) => void;
}

interface StaticProps extends CommonProps {
  options: readonly SearchableSelectOption[];
  /** Render at most this many matches; the selected one is always kept. */
  maxVisibleOptions?: number;
  load?: never;
  queryKey?: never;
}

interface AsyncProps extends CommonProps {
  /** Server search with paging: for lists that can be large. */
  load: SearchableSelectLoader;
  /** Identifies the source (and its filters, e.g. the parent) for caching. */
  queryKey: readonly unknown[];
  options?: never;
  maxVisibleOptions?: never;
}

export type SearchableSelectProps = StaticProps | AsyncProps;

/**
 * The dashboard's combobox: a searchable list in a popover. Use it whenever
 * choosing one option, including fixed enums. Give it `load` + `queryKey`
 * when the source is large (server search, paged).
 */
export function SearchableSelect(props: SearchableSelectProps) {
  return props.load ? <AsyncSearchableSelect {...props} /> : <StaticSearchableSelect {...(props as StaticProps)} />;
}

function StaticSearchableSelect({ options, maxVisibleOptions, ...common }: StaticProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = React.useMemo(
    () =>
      options.filter((option) => {
        if (!normalizedQuery) return true;
        return [option.label, option.value, option.description ?? "", ...(option.keywords ?? [])].some((term) =>
          term.toLocaleLowerCase().includes(normalizedQuery),
        );
      }),
    [normalizedQuery, options],
  );
  const limit = maxVisibleOptions === undefined ? undefined : Math.max(1, Math.trunc(maxVisibleOptions));
  const visible = React.useMemo(() => {
    if (limit === undefined || filtered.length <= limit) return filtered;
    const first = filtered.slice(0, limit);
    const selected = filtered.find((option) => option.value === common.value);
    if (!selected || first.some((option) => option.value === selected.value)) return first;
    return [selected, ...first.slice(0, Math.max(0, limit - 1))];
  }, [filtered, limit, common.value]);

  return (
    <ComboboxView
      {...common}
      open={open}
      setOpen={setOpen}
      query={query}
      setQuery={setQuery}
      options={visible}
      selectedOption={options.find((option) => option.value === common.value)}
      state="ready"
      hidden={{ shown: visible.length, total: filtered.length }}
    />
  );
}

function AsyncSearchableSelect({ load, queryKey, ...common }: AsyncProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const search = useDebounce(query.trim(), 250);
  const pages = useInfiniteQuery({
    queryKey: [...queryKey, "searchable-select", search],
    queryFn: ({ pageParam, signal }) => load({ search, page: pageParam, signal }),
    initialPageParam: 1,
    getNextPageParam: (last, all) => (last.hasMore ? all.length + 1 : undefined),
    enabled: open && !common.disabled,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const options = React.useMemo(() => {
    const seen = new Set<string>();
    return (pages.data?.pages ?? []).flatMap((page) => page.options).filter((option) => {
      if (seen.has(option.value)) return false;
      seen.add(option.value);
      return true;
    });
  }, [pages.data]);

  return (
    <ComboboxView
      {...common}
      open={open}
      setOpen={setOpen}
      query={query}
      setQuery={setQuery}
      options={options}
      selectedOption={options.find((option) => option.value === common.value)}
      state={pages.isError && !pages.data ? "error" : pages.isPending ? "loading" : "ready"}
      searching={pages.isFetching && !pages.isFetchingNextPage}
      hasMore={pages.hasNextPage}
      loadingMore={pages.isFetchingNextPage}
      pageFailed={pages.isFetchNextPageError}
      onLoadMore={() => void pages.fetchNextPage()}
      onRetry={() => void pages.refetch()}
    />
  );
}

interface ViewProps extends CommonProps {
  open: boolean;
  setOpen: (open: boolean) => void;
  query: string;
  setQuery: (query: string) => void;
  options: readonly SearchableSelectOption[];
  selectedOption: SearchableSelectOption | undefined;
  state: "loading" | "error" | "ready";
  searching?: boolean;
  hasMore?: boolean;
  loadingMore?: boolean;
  pageFailed?: boolean;
  onLoadMore?: () => void;
  onRetry?: () => void;
  hidden?: { shown: number; total: number };
}

function ComboboxView({
  value,
  onValueChange,
  placeholder,
  searchPlaceholder,
  emptyMessage,
  disabled = false,
  required = false,
  id,
  ariaLabel,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  triggerClassName,
  clearable = false,
  selectedLabel,
  busy = false,
  triggerRef,
  onBlur,
  onFocus,
  onOpenChange,
  open,
  setOpen,
  query,
  setQuery,
  options,
  selectedOption,
  state,
  searching = false,
  hasMore = false,
  loadingMore = false,
  pageFailed = false,
  onLoadMore,
  onRetry,
  hidden,
}: ViewProps) {
  const t = useMessages(comboboxMessages);
  const [activeIndex, setActiveIndex] = React.useState(0);
  // The last pick, so the field shows it before the caller re-renders with a label.
  const [picked, setPicked] = React.useState<SearchableSelectOption | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const listId = React.useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  const label = selectedOption?.label
    ?? (picked && picked.value === value ? picked.label : undefined)
    ?? (value ? selectedLabel : undefined);
  const selectable = options.flatMap((option, index) => (option.disabled ? [] : [index]));
  const safeActive = selectable.includes(activeIndex) ? activeIndex : (selectable[0] ?? -1);
  const activeOption = safeActive >= 0 ? options[safeActive] : undefined;
  const canClear = clearable && Boolean(value) && !disabled;

  const changeOpen = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
    if (!next) setQuery("");
  };

  function select(option: SearchableSelectOption) {
    if (option.disabled) return;
    setPicked(option);
    if (option.value !== value) onValueChange(option.value, option);
    changeOpen(false);
  }

  function moveTo(index: number) {
    setActiveIndex(index);
    requestAnimationFrame(() => {
      const list = listRef.current;
      const option = document.getElementById(optionId(index));
      if (!list || !option) return;
      const bounds = list.getBoundingClientRect();
      const row = option.getBoundingClientRect();
      if (row.top < bounds.top) list.scrollTop += row.top - bounds.top;
      else if (row.bottom > bounds.bottom) list.scrollTop += row.bottom - bounds.bottom;
    });
  }

  function move(direction: -1 | 1) {
    const position = Math.max(selectable.indexOf(safeActive), 0);
    const next = position + direction;
    if (next >= selectable.length && hasMore && !loadingMore) onLoadMore?.();
    moveTo(selectable[Math.max(0, Math.min(next, selectable.length - 1))] ?? 0);
  }

  // Infinite scroll: the next page loads as the list nears its end.
  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const list = event.currentTarget;
    if (hasMore && !loadingMore && !pageFailed && list.scrollTop + list.clientHeight >= list.scrollHeight - 48) {
      onLoadMore?.();
    }
  };

  let lastGroup: string | undefined;
  const rows = options.map((option, index) => {
    const heading = option.group && option.group !== lastGroup ? option.group : null;
    lastGroup = option.group;
    return (
      <React.Fragment key={option.value}>
        {heading ? (
          <div role="presentation" className="px-2 pb-1 pt-2 text-caption text-muted-foreground">
            {heading}
          </div>
        ) : null}
        <button
          id={optionId(index)}
          type="button"
          role="option"
          tabIndex={-1}
          aria-selected={option.value === value}
          disabled={option.disabled}
          data-active={index === safeActive || undefined}
          onMouseMove={() => {
            if (!option.disabled && index !== safeActive) setActiveIndex(index);
          }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => select(option)}
          className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-body outline-none data-[active]:bg-accent data-[active]:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 sm:min-h-8"
        >
          <Check
            aria-hidden="true"
            data-selected={option.value === value || undefined}
            className="size-3.5 shrink-0 opacity-0 data-[selected]:opacity-100"
          />
          <span className="min-w-0 truncate">
            {option.label}
            {option.description ? <span className="text-muted-foreground"> · {option.description}</span> : null}
          </span>
        </button>
      </React.Fragment>
    );
  });

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <div data-slot="searchable-select" className={cn("relative inline-block max-w-full align-middle", triggerClassName)}>
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            onBlur={onBlur}
            onFocus={onFocus}
            id={id}
            type="button"
            role="combobox"
            aria-label={ariaLabel}
            aria-controls={listId}
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-required={required || undefined}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            aria-busy={busy || undefined}
            disabled={disabled}
            className={cn(
              fieldClassName,
              "flex h-11 w-full items-center gap-2 text-left sm:h-9",
            )}
          >
            <span data-placeholder={label ? undefined : ""} className="min-w-0 flex-1 truncate data-[placeholder]:text-muted-foreground">
              {busy ? t("loading") : label ?? placeholder ?? t("placeholder")}
            </span>
            {/* Room for the clear button, which sits just before the chevron. */}
            {canClear ? <span aria-hidden="true" className="size-8 shrink-0 sm:size-6" /> : null}
            {busy ? (
              <Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <ChevronsUpDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            )}
          </button>
        </PopoverTrigger>
        {canClear ? (
          <button
            type="button"
            aria-label={t("clear", { name: label ?? ariaLabel ?? t("clearSelection") })}
            title={t("clearSelection")}
            onClick={() => {
              setPicked(null);
              onValueChange("", null);
            }}
            className="absolute right-8 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:size-6"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        ) : null}
      </div>
      <PopoverContent
        data-slot="searchable-select-content"
        align="start"
        side="bottom"
        sideOffset={4}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
        }}
        className="flex w-(--radix-popover-trigger-width) min-w-60 max-w-(--radix-popover-content-available-width) flex-col overflow-hidden p-0"
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3 sm:h-9">
          <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
              listRef.current?.scrollTo?.({ top: 0 });
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                move(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                move(-1);
              } else if (event.key === "Home") {
                event.preventDefault();
                moveTo(selectable[0] ?? 0);
              } else if (event.key === "End") {
                event.preventDefault();
                moveTo(selectable.at(-1) ?? 0);
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (activeOption) select(activeOption);
              } else if (event.key === "Escape") {
                changeOpen(false);
              }
            }}
            placeholder={searchPlaceholder ?? t("search")}
            role="combobox"
            aria-label={searchPlaceholder ?? t("search")}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-expanded={open}
            aria-activedescendant={activeOption ? optionId(safeActive) : undefined}
            className="h-full min-w-0 flex-1 bg-transparent text-body-lg outline-none placeholder:text-muted-foreground sm:text-body"
          />
          {searching && state === "ready" ? (
            <Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : null}
        </div>
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel ?? t("options")}
          aria-busy={state === "loading" || searching || undefined}
          data-slot="searchable-select-list"
          onScroll={onScroll}
          className="max-h-60 min-h-0 overflow-y-auto overscroll-contain p-1.5"
        >
          {state === "loading" ? (
            <p role="status" className="flex items-center justify-center gap-2 px-3 py-5 text-body text-muted-foreground">
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              {t("loading")}
            </p>
          ) : state === "error" ? (
            <div role="alert" className="space-y-2 px-3 py-4 text-center text-body text-muted-foreground">
              <p>{t("loadFailed")}</p>
              <button type="button" onClick={onRetry} className="text-link hover:underline focus-visible:underline focus-visible:outline-none">
                {t("retry")}
              </button>
            </div>
          ) : options.length === 0 ? (
            <p className="px-3 py-5 text-center text-body text-muted-foreground">{emptyMessage ?? t("empty")}</p>
          ) : (
            rows
          )}
          {hidden && hidden.total > hidden.shown ? (
            <p data-slot="searchable-select-overflow-hint" className="border-t px-3 py-2 text-body text-muted-foreground">
              {t("showing", { shown: hidden.shown, total: hidden.total })}
            </p>
          ) : null}
        </div>
        {state === "ready" && (hasMore || pageFailed) ? (
          <div data-slot="searchable-select-footer" className="flex shrink-0 items-center justify-center border-t p-1.5">
            <button
              type="button"
              disabled={loadingMore}
              onClick={onLoadMore}
              className="flex h-9 items-center gap-2 rounded-md px-3 text-body text-link hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 sm:h-8"
            >
              {loadingMore ? <Loader2 aria-hidden="true" className="size-3.5 animate-spin" /> : null}
              {pageFailed && !loadingMore ? t("retry") : t("loadMore")}
            </button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
