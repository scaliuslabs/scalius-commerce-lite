import { useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { AlertCircle, Check, ChevronsUpDown, Loader2 } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { useDebounce } from "~/hooks/use-debounce";
import { navigationResourcesQueryOptions } from "~/lib/api-query-options/navigation";
import type {
  NavigationResourceOption,
  NavigationResourceType,
} from "~/lib/api-functions/navigation-authority";
import { Button } from "~/components/ui/button";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "~/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";

const RESOURCE_PAGE_SIZE = 20;
const RESOURCE_SEARCH_DEBOUNCE_MS = 250;

const RESOURCE_LABELS: Record<NavigationResourceType, string> = {
  page: "page",
  category: "category",
  collection: "collection",
  product: "product",
};

interface NavigationResourcePickerProps {
  id: string;
  type: NavigationResourceType;
  value: string;
  fallbackLabel?: string;
  onValueChange: (resourceId: string) => void;
}

function uniqueOptions(pages: Array<{ items: NavigationResourceOption[] }>): NavigationResourceOption[] {
  const byId = new Map<string, NavigationResourceOption>();
  for (const page of pages) {
    for (const item of page.items) byId.set(item.id, item);
  }
  return [...byId.values()];
}

export function NavigationResourcePicker({
  id,
  type,
  value,
  fallbackLabel,
  onValueChange,
}: NavigationResourcePickerProps) {
  const [open, setOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const debouncedSearch = useDebounce(searchTerm.trim(), RESOURCE_SEARCH_DEBOUNCE_MS);
  const resourceQuery = useInfiniteQuery({
    ...navigationResourcesQueryOptions({
      type,
      query: debouncedSearch,
      limit: RESOURCE_PAGE_SIZE,
      selectedId: value || undefined,
    }),
    enabled: open || Boolean(value),
  });
  const options = useMemo(
    () => uniqueOptions(resourceQuery.data?.pages ?? []),
    [resourceQuery.data?.pages],
  );
  const selected = useMemo(() => {
    const exact = options.find((option) => option.id === value);
    if (exact) return exact;
    return resourceQuery.data?.pages
      .map((page) => page.selected)
      .find((option): option is NavigationResourceOption => option?.id === value) ?? null;
  }, [options, resourceQuery.data?.pages, value]);
  const label = RESOURCE_LABELS[type];
  const isDebouncing = searchTerm.trim() !== debouncedSearch;
  const isInitialLoading = isDebouncing || resourceQuery.isPending
    || (resourceQuery.isFetching && options.length === 0);
  const isInitialError = resourceQuery.isError && options.length === 0;

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setSearchTerm("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={`Choose ${label}`}
          className="h-11 w-full justify-between px-3 font-normal sm:h-9"
        >
          <span className="min-w-0 truncate">
            {selected?.name || fallbackLabel || `Choose ${label}`}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={16}
        className="w-[min(32rem,calc(100vw-2rem))] p-0"
      >
        <Command shouldFilter={false}>
          <CommandInput
            aria-label={`Search ${label}s`}
            placeholder={`Search ${label}s...`}
            value={searchTerm}
            onValueChange={setSearchTerm}
            className="h-11 border-none focus:ring-0 sm:h-10"
          />
          <CommandList className="max-h-[min(50vh,20rem)] overflow-auto">
            {selected && !selected.available ? (
              <div className="border-b px-3 py-2 text-sm" role="status">
                <span className="font-medium">{selected.name}</span>
                <span className="ml-2 text-xs text-destructive">Unavailable</span>
              </div>
            ) : null}

            {isInitialLoading ? (
              <div className="flex items-center justify-center py-7" role="status">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                <span className="text-sm text-muted-foreground">Searching {label}s...</span>
              </div>
            ) : isInitialError ? (
              <div className="space-y-2 px-3 py-6 text-center" role="alert">
                <AlertCircle className="mx-auto h-4 w-4 text-destructive" />
                <p className="text-sm text-muted-foreground">
                  {label[0]!.toUpperCase() + label.slice(1)}s could not be loaded.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-11 sm:h-8"
                  onClick={() => void resourceQuery.refetch()}
                >
                  Retry
                </Button>
              </div>
            ) : options.length === 0 ? (
              <div className="px-3 py-7 text-center text-sm text-muted-foreground">
                No {label}s found.
              </div>
            ) : (
              <CommandGroup heading={`${label[0]!.toUpperCase() + label.slice(1)}s`}>
                {options.map((option) => (
                  <CommandItem
                    key={option.id}
                    value={option.id}
                    onSelect={() => {
                      onValueChange(option.id);
                      setOpen(false);
                    }}
                    className="min-h-11 cursor-pointer gap-2 sm:min-h-8"
                  >
                    <Check
                      className={cn(
                        "h-4 w-4 shrink-0",
                        option.id === value ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">{option.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {!isInitialLoading && !isInitialError && resourceQuery.hasNextPage ? (
              <div className="border-t p-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-11 w-full sm:h-8"
                  disabled={resourceQuery.isFetchingNextPage}
                  onClick={(event) => {
                    event.preventDefault();
                    void resourceQuery.fetchNextPage();
                  }}
                >
                  {resourceQuery.isFetchingNextPage ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Loading...
                    </>
                  ) : resourceQuery.isFetchNextPageError ? (
                    "Retry loading more"
                  ) : (
                    "Load more"
                  )}
                </Button>
              </div>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
