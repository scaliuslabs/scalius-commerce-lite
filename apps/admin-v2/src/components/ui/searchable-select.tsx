import * as React from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";

import { cn } from "@scalius/shared/utils";
import { Button } from "./button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./popover";

export interface SearchableSelectOption {
  value: string;
  label: string;
  keywords?: string[];
  disabled?: boolean;
}

interface SearchableSelectProps {
  value?: string;
  onValueChange: (value: string) => void;
  options: readonly SearchableSelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  required?: boolean;
  maxVisibleOptions?: number;
  id?: string;
  ariaLabel?: string;
  triggerClassName?: string;
  contentClassName?: string;
}

/**
 * Searchable selector for lists whose size is controlled by merchant or server
 * data. Short, fixed enums should continue using the Select primitive.
 */
export function SearchableSelect({
  value,
  onValueChange,
  options,
  placeholder = "Select an option",
  searchPlaceholder = "Search options...",
  emptyMessage = "No options found.",
  disabled = false,
  required = false,
  maxVisibleOptions,
  id,
  ariaLabel,
  triggerClassName,
  contentClassName,
}: SearchableSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listId = React.useId();
  const selectedOption = options.find((option) => option.value === value);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredOptions = React.useMemo(
    () => options.filter((option) => {
      if (!normalizedQuery) return true;
      return [option.label, option.value, ...(option.keywords ?? [])].some(
        (term) => term.toLocaleLowerCase().includes(normalizedQuery),
      );
    }),
    [normalizedQuery, options],
  );
  const boundedVisibleLimit = maxVisibleOptions === undefined
    ? undefined
    : Math.max(1, Math.trunc(maxVisibleOptions));
  const visibleOptions = React.useMemo(() => {
    if (
      boundedVisibleLimit === undefined ||
      filteredOptions.length <= boundedVisibleLimit
    ) {
      return filteredOptions;
    }

    const firstOptions = filteredOptions.slice(0, boundedVisibleLimit);
    const selectedFilteredOption = filteredOptions.find(
      (option) => option.value === value,
    );

    if (
      !selectedFilteredOption ||
      firstOptions.some((option) => option.value === selectedFilteredOption.value)
    ) {
      return firstOptions;
    }

    return [
      selectedFilteredOption,
      ...firstOptions.slice(0, Math.max(0, boundedVisibleLimit - 1)),
    ];
  }, [boundedVisibleLimit, filteredOptions, value]);
  const hiddenOptionCount = filteredOptions.length - visibleOptions.length;
  const selectableIndexes = visibleOptions.flatMap((option, index) =>
    option.disabled ? [] : [index],
  );
  const safeActiveIndex = selectableIndexes.includes(activeIndex)
    ? activeIndex
    : (selectableIndexes[0] ?? 0);
  const activeOption = visibleOptions[safeActiveIndex];

  const focusSearch = React.useCallback(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  function selectOption(option: SearchableSelectOption) {
    if (option.disabled) return;
    onValueChange(option.value);
    setOpen(false);
    setQuery("");
  }

  function moveActive(direction: -1 | 1) {
    const currentPosition = Math.max(
      selectableIndexes.indexOf(safeActiveIndex),
      0,
    );
    const nextPosition = Math.max(
      0,
      Math.min(currentPosition + direction, selectableIndexes.length - 1),
    );
    setActiveIndex(selectableIndexes[nextPosition] ?? 0);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-label={ariaLabel}
          aria-controls={listId}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-required={required || undefined}
          disabled={disabled}
          className={cn(
            "h-11 min-w-0 justify-between gap-2 px-3 text-sm font-normal sm:h-9",
            triggerClassName,
          )}
        >
          <span className={cn("truncate", !selectedOption && "text-muted-foreground")}>
            {selectedOption?.label ?? placeholder}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        data-slot="searchable-select-content"
        align="start"
        side="bottom"
        sideOffset={4}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          focusSearch();
        }}
        className={cn(
          "w-[var(--radix-popover-trigger-width)] overflow-hidden p-0",
          contentClassName,
        )}
      >
        <div className="bg-popover text-popover-foreground">
          <div className="flex h-11 items-center gap-2 border-b px-3 sm:h-9">
            <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  moveActive(1);
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  moveActive(-1);
                } else if (event.key === "Home") {
                  event.preventDefault();
                  setActiveIndex(selectableIndexes[0] ?? 0);
                } else if (event.key === "End") {
                  event.preventDefault();
                  setActiveIndex(selectableIndexes.at(-1) ?? 0);
                } else if (event.key === "Enter" && activeOption) {
                  event.preventDefault();
                  selectOption(activeOption);
                } else if (event.key === "Escape") {
                  setOpen(false);
                }
              }}
              placeholder={searchPlaceholder}
              role="combobox"
              aria-label={searchPlaceholder}
              aria-autocomplete="list"
              aria-controls={listId}
              aria-expanded={open}
              aria-activedescendant={activeOption ? `${listId}-option-${safeActiveIndex}` : undefined}
              className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div
            id={listId}
            role="listbox"
            aria-label="Options"
            data-slot="searchable-select-list"
            className="max-h-60 overflow-y-auto overscroll-contain p-1"
          >
            {visibleOptions.length === 0 ? (
              <p className="px-3 py-5 text-center text-sm text-muted-foreground">
                {emptyMessage}
              </p>
            ) : visibleOptions.map((option, index) => (
              <button
                key={option.value}
                id={`${listId}-option-${index}`}
                type="button"
                role="option"
                aria-selected={option.value === value}
                disabled={option.disabled}
                onMouseMove={() => {
                  if (!option.disabled) setActiveIndex(index);
                }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectOption(option)}
                className={cn(
                  "flex min-h-11 w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none sm:min-h-8",
                  index === safeActiveIndex && "bg-accent text-accent-foreground",
                  "focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
                )}
              >
                <Check
                  aria-hidden="true"
                  className={cn(
                    "size-3.5 shrink-0",
                    option.value === value ? "opacity-100" : "opacity-0",
                  )}
                />
                <span className="min-w-0 truncate">{option.label}</span>
              </button>
            ))}
            {hiddenOptionCount > 0 ? (
              <p
                data-slot="searchable-select-overflow-hint"
                className="border-t px-3 py-2 text-xs text-muted-foreground"
              >
                Showing {visibleOptions.length} of {filteredOptions.length}. Search to narrow results.
              </p>
            ) : null}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
