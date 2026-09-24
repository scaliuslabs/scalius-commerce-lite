import { useMemo, useState, type ReactNode } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { AlertCircle, Check, ChevronsUpDown, Loader2 } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { useDebounce } from "~/hooks/use-debounce";
import { navigationResourcesQueryOptions } from "~/lib/api-query-options/navigation";
import type {
  NavigationResourceOption,
  NavigationResourceType,
} from "~/lib/api-query-options/navigation";
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
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";

const RESOURCE_PAGE_SIZE = 20;
const RESOURCE_SEARCH_DEBOUNCE_MS = 250;

interface NavigationResourcePickerProps {
  id: string;
  type: NavigationResourceType;
  /** Let the merchant switch between these kinds inside the picker. */
  types?: NavigationResourceType[];
  value: string;
  fallbackLabel?: string;
  /** Replaces the default combobox button that shows the chosen name. */
  trigger?: ReactNode;
  onValueChange: (option: NavigationResourceOption) => void;
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
  type: initialType,
  types,
  value,
  fallbackLabel,
  trigger,
  onValueChange,
}: NavigationResourcePickerProps) {
  const t = useMessages(onlineStoreMessages);
  const [open, setOpen] = useState(false);
  const [type, setType] = useState(initialType);
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
        {trigger ?? (
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-label={t(`choose_${type}`)}
            className="w-full justify-between"
          >
            <span className="min-w-0 truncate">
              {selected?.name || fallbackLabel || t(`choose_${type}`)}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={16}
        className="w-80 p-0"
      >
        {types && types.length > 1 ? (
          <div className="border-b p-1">
            <Tabs value={type} onValueChange={(next) => setType(next as NavigationResourceType)}>
              <TabsList className="w-full">
                {types.map((option) => (
                  <TabsTrigger key={option} value={option}>{t(`link_${option}`)}</TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
        ) : null}
        <Command shouldFilter={false}>
          <CommandInput
            aria-label={t("search")}
            placeholder={t("search")}
            value={searchTerm}
            onValueChange={setSearchTerm}
          />
          <CommandList className="max-h-80 overflow-auto">
            {selected && !selected.available ? (
              <div className="border-b px-3 py-2 text-body" role="status">
                <span className="font-medium">{selected.name}</span>
                <span className="ml-2 text-destructive">{t("unavailable")}</span>
              </div>
            ) : null}

            {isInitialLoading ? (
              <div className="flex items-center justify-center py-7" role="status">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                <span className="text-body text-muted-foreground">{t("searching")}</span>
              </div>
            ) : isInitialError ? (
              <div className="space-y-2 px-3 py-6 text-center" role="alert">
                <AlertCircle className="mx-auto h-4 w-4 text-destructive" />
                <p className="text-body text-muted-foreground">{t("loadFailed")}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void resourceQuery.refetch()}
                >
                  {t("retry")}
                </Button>
              </div>
            ) : options.length === 0 ? (
              <div className="px-3 py-7 text-center text-body text-muted-foreground">
                {t("noResults")}
              </div>
            ) : (
              <CommandGroup>
                {options.map((option) => (
                  <CommandItem
                    key={option.id}
                    value={option.id}
                    onSelect={() => {
                      onValueChange(option);
                      setOpen(false);
                    }}
                    className="cursor-pointer"
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
                  className="w-full"
                  disabled={resourceQuery.isFetchingNextPage}
                  onClick={(event) => {
                    event.preventDefault();
                    void resourceQuery.fetchNextPage();
                  }}
                >
                  {resourceQuery.isFetchingNextPage ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {t("loading")}
                    </>
                  ) : resourceQuery.isFetchNextPageError ? (
                    t("retry")
                  ) : (
                    t("loadMore")
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
