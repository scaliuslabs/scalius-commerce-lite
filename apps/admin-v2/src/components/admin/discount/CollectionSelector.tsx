//src/components/admin/discount/CollectionSelector.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../../ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import { Button } from "../../ui/button";
import { Check, ChevronsUpDown, Folder, Loader2, X } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { Badge } from "../../ui/badge";
import { getCollectionsByIds } from "~/lib/api-functions/collections";
import { useDebounce } from "~/hooks/use-debounce";
import { collectionPickerOptionsQueryOptions } from "~/lib/api-query-options/collections";

// Collection interface
export interface DiscountCollectionOption {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  presentation?: "grid" | "carousel";
}

interface CollectionSelectorProps {
  selectedCollections: DiscountCollectionOption[];
  onChange: (collections: DiscountCollectionOption[]) => void;
  buttonLabel?: string;
  className?: string;
  isLoading?: boolean;
  maxItems?: number;
}

const PAGE_SIZE = 10;
const SEARCH_DEBOUNCE_MS = 300;

export function CollectionSelector({
  selectedCollections = [] as DiscountCollectionOption[],
  onChange,
  buttonLabel = "Select collections",
  className,
  isLoading = false,
  maxItems,
}: CollectionSelectorProps) {
  const [open, setOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const lastResolutionSignatureRef = useRef("");
  const debouncedSearch = useDebounce(searchTerm.trim(), SEARCH_DEBOUNCE_MS);
  const collectionQuery = useInfiniteQuery({
    ...collectionPickerOptionsQueryOptions({
      search: debouncedSearch,
      limit: PAGE_SIZE,
    }),
    enabled: open,
  });
  const displayedCollections = useMemo(() => {
    const byId = new Map<string, DiscountCollectionOption>();
    for (const page of collectionQuery.data?.pages ?? []) {
      for (const collection of page.collections) {
        byId.set(collection.id, {
          id: collection.id,
          name: collection.name,
          description: null,
          slug: "",
          presentation: collection.presentation,
        });
      }
    }
    return [...byId.values()];
  }, [collectionQuery.data?.pages]);
  const totalCollections = collectionQuery.data?.pages[0]?.pagination.total ?? 0;
  const isDebouncing = searchTerm.trim() !== debouncedSearch;
  const isInitialLoading = isDebouncing || collectionQuery.isPending ||
    (collectionQuery.isFetching && displayedCollections.length === 0);
  const isInitialError = collectionQuery.isError && displayedCollections.length === 0;

  useEffect(() => {
    const unresolvedIds = selectedCollections
      .filter((collection) => collection.name === collection.id || !collection.name)
      .map((collection) => collection.id);
    const signature = unresolvedIds.join("|");
    if (!signature || signature === lastResolutionSignatureRef.current) return;

    lastResolutionSignatureRef.current = signature;
    let cancelled = false;

    const resolveNames = async () => {
      try {
        const data = await getCollectionsByIds({ data: { ids: unresolvedIds } });
        const allCollections = data.collections || [];
        const collectionMap = new Map(
          allCollections.map((c) => [c.id, c]),
        );

        const resolved = selectedCollections.map((sc) => {
          const found = collectionMap.get(sc.id);
          if (found && (sc.name === sc.id || !sc.name)) {
            return {
              ...sc,
              name: found.name,
              presentation: found.presentation || sc.presentation,
            };
          }
          return sc;
        });

        if (!cancelled &&
          resolved.some(
            (r, i) =>
              r.name !== selectedCollections[i].name ||
              r.presentation !== selectedCollections[i].presentation,
          )
        ) {
          onChange(resolved);
        }
      } catch (error: unknown) {
        if (import.meta.env.DEV) console.error("Error resolving collection names:", error);
        if (!cancelled) lastResolutionSignatureRef.current = "";
      }
    };

    void resolveNames();
    return () => {
      cancelled = true;
    };
  }, [selectedCollections, onChange]);

  const handleSelectCollection = (collection: DiscountCollectionOption) => {
    const isSelected = selectedCollections.some((c) => c.id === collection.id);

    if (maxItems && selectedCollections.length >= maxItems && !isSelected) {
      return;
    }

    let newSelectedCollections;
    if (isSelected) {
      // Remove collection if already selected
      newSelectedCollections = selectedCollections.filter(
        (c) => c.id !== collection.id,
      );
    } else {
      // Add collection
      newSelectedCollections = [...selectedCollections, collection];
    }

    onChange(newSelectedCollections);
  };

  const handleRemoveCollection = (collectionId: string) => {
    const newSelectedCollections = selectedCollections.filter(
      (c) => c.id !== collectionId,
    );
    onChange(newSelectedCollections);
  };

  const selectedCollectionsMap = useMemo(() => {
    const map = new Map<string, boolean>();
    selectedCollections.forEach((collection) => {
      map.set(collection.id, true);
    });
    return map;
  }, [selectedCollections]);

  return (
    <div className={className}>
      <Popover
        open={open}
        onOpenChange={(newOpen) => {
          setOpen(newOpen);
          if (!newOpen) {
            setSearchTerm("");
          }
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="h-11 w-full justify-between sm:h-9"
            disabled={isLoading}
          >
            <div className="flex items-center gap-2">
              <Folder className="h-4 w-4" />
              <span className="truncate">
                {selectedCollections.length > 0
                  ? `${selectedCollections.length} collection${selectedCollections.length > 1 ? "s" : ""} selected`
                  : buttonLabel}
              </span>
            </div>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          collisionPadding={16}
          className="w-[min(22rem,calc(100vw-2rem))] p-0"
        >
          <Command shouldFilter={false}>
            <CommandInput
              aria-label="Search collections"
              placeholder="Search collections..."
              value={searchTerm}
              onValueChange={setSearchTerm}
              className="h-11 border-none focus:ring-0 sm:h-10"
            />
            <CommandList className="max-h-[min(50vh,20rem)] overflow-auto">
              {isInitialLoading ? (
                <div className="flex items-center justify-center py-7" role="status">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  <span className="text-sm text-muted-foreground">
                    Searching collections...
                  </span>
                </div>
              ) : isInitialError ? (
                <div role="alert" className="space-y-2 px-3 py-6 text-center">
                  <p className="text-sm text-muted-foreground">
                    Collections could not be loaded.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-11 sm:h-8"
                    onClick={() => void collectionQuery.refetch()}
                  >
                    Retry
                  </Button>
                </div>
              ) : displayedCollections.length === 0 ? (
                <div className="px-3 py-7 text-center text-sm text-muted-foreground">
                  No collections found.
                </div>
              ) : (
                <CommandGroup>
                  {displayedCollections.map((collection) => {
                    const isSelected = selectedCollectionsMap.has(collection.id);
                    const atLimit = Boolean(
                      maxItems && selectedCollections.length >= maxItems && !isSelected,
                    );
                    return (
                      <CommandItem
                        key={collection.id}
                        value={collection.id}
                        onSelect={() => handleSelectCollection(collection)}
                        disabled={atLimit}
                        className="min-h-11 cursor-pointer sm:min-h-8"
                      >
                        <div className="flex w-full items-center justify-between">
                          <div className="flex items-center gap-2 truncate">
                            <Check
                              className={cn(
                                "mr-2 h-4 w-4 shrink-0",
                                isSelected ? "opacity-100" : "opacity-0",
                              )}
                            />
                            <span className="truncate">{collection.name}</span>
                          </div>
                          {collection.presentation && (
                            <Badge
                              variant="outline"
                              className="ml-2 shrink-0 px-1.5 py-0 text-[10px]"
                            >
                              {collection.presentation === "grid" ? "Grid" : "Carousel"}
                            </Badge>
                          )}
                        </div>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              )}

              {!isInitialLoading && !isInitialError && collectionQuery.hasNextPage && (
                <div className="py-2 px-2 border-t">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 w-full sm:h-8"
                    size="sm"
                    onClick={(event) => {
                      event.preventDefault();
                      void collectionQuery.fetchNextPage();
                    }}
                    disabled={collectionQuery.isFetchingNextPage}
                  >
                    {collectionQuery.isFetchingNextPage ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Loading...
                      </>
                    ) : collectionQuery.isFetchNextPageError ? (
                      "Retry loading more"
                    ) : (
                      <>
                        Load more ({displayedCollections.length} of{" "}
                        {totalCollections})
                      </>
                    )}
                  </Button>
                </div>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {selectedCollections.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-3">
          {selectedCollections.map((collection) => (
            <Badge
              key={collection.id}
              variant="secondary"
              className="flex items-center gap-1 pr-1.5"
            >
              <span className="truncate max-w-[180px]">
                {collection.name}
              </span>
              {collection.presentation && (
                <Badge
                  variant="outline"
                  className="ml-1 text-[10px] px-1 py-0 border-muted-foreground/30"
                >
                  {collection.presentation === "grid" ? "Grid" : "Carousel"}
                </Badge>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="-my-2 ml-1 h-11 w-11 p-0 sm:my-0 sm:h-5 sm:w-5"
                aria-label={`Remove ${collection.name}`}
                onClick={() => handleRemoveCollection(collection.id)}
              >
                <X className="h-3 w-3" />
                <span className="sr-only">Remove {collection.name}</span>
              </Button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
