//src/components/admin/discount/CollectionSelector.tsx
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Command,
  CommandEmpty,
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
import { getCollections, getCollectionsByIds } from "~/lib/api-functions/collections";

// Collection interface
interface Collection {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  type?: "manual" | "dynamic";
}

interface CollectionSelectorProps {
  selectedCollections: Collection[];
  onChange: (collections: Collection[]) => void;
  buttonLabel?: string;
  className?: string;
  isLoading?: boolean;
  maxItems?: number;
}

const PAGE_SIZE = 10;

export function CollectionSelector({
  selectedCollections = [] as Collection[],
  onChange,
  buttonLabel = "Select Collections",
  className,
  isLoading = false,
  maxItems,
}: CollectionSelectorProps) {
  const [open, setOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [displayedCollections, setDisplayedCollections] = useState<
    Collection[]
  >([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCollections, setTotalCollections] = useState(0);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestSearchTermRef = useRef(searchTerm);
  const lastResolutionSignatureRef = useRef("");
  const skipNextSearchLoadRef = useRef(false);

  useEffect(() => {
    latestSearchTermRef.current = searchTerm;
  }, [searchTerm]);

  const loadCollections = useCallback(async (page = 1, search = "") => {
    try {
      if (page === 1) {
        setIsSearching(true);
      } else {
        setIsLoadingMore(true);
      }

      const data = await getCollections({
        data: {
          limit: PAGE_SIZE,
          page,
          search: search.trim() || undefined,
        },
      });

      const collectionsArray = data.collections;
      const mapped: Collection[] = collectionsArray.map((c) => ({
        id: c.id,
        name: c.name,
        description: null,
        slug: "",
        type: c.type,
      }));

      if (page === 1) {
        setDisplayedCollections(mapped);
      } else {
        setDisplayedCollections((prev) => [...prev, ...mapped]);
      }

      setTotalPages(data.pagination?.totalPages || 1);
      setTotalCollections(data.pagination?.total || 0);
      setCurrentPage(page);
    } catch (error: unknown) {
      if (import.meta.env.DEV) console.error("Error loading collections:", error);
    } finally {
      setIsSearching(false);
      setIsLoadingMore(false);
    }
  }, []);

  // Resolve selected collections that only have IDs (name === id)
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
              type: found.type || sc.type,
            };
          }
          return sc;
        });

        // Only update if names actually changed
        if (!cancelled &&
          resolved.some(
            (r, i) =>
              r.name !== selectedCollections[i].name ||
              r.type !== selectedCollections[i].type,
          )
        ) {
          onChange(resolved);
        }
      } catch (error: unknown) {
        if (import.meta.env.DEV) console.error("Error resolving collection names:", error);
      }
    };

    void resolveNames();
    return () => {
      cancelled = true;
    };
  }, [selectedCollections, onChange]);

  // Load collections when dropdown opens
  useEffect(() => {
    if (open) {
      skipNextSearchLoadRef.current = true;
      loadCollections(1, latestSearchTermRef.current);
    }
  }, [loadCollections, open]);

  // Handle search input changes
  useEffect(() => {
    if (!open) return;

    if (skipNextSearchLoadRef.current && searchTerm === "") {
      skipNextSearchLoadRef.current = false;
      return;
    }

    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    // Reset to first page when search term changes
    if (currentPage !== 1) {
      setCurrentPage(1);
    }

    searchTimeoutRef.current = setTimeout(() => {
      loadCollections(1, searchTerm);
    }, 300);

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [currentPage, loadCollections, open, searchTerm]);

  // Load more collections for pagination
  const loadMoreCollections = () => {
    if (currentPage < totalPages && !isLoadingMore) {
      loadCollections(currentPage + 1, searchTerm);
    }
  };

  const handleSelectCollection = (collection: Collection) => {
    // Check if collection is already selected
    const isSelected = selectedCollections.some((c) => c.id === collection.id);

    // Check if max items limit reached
    if (maxItems && selectedCollections.length >= maxItems && !isSelected) {
      return; // Don't add more if limit reached
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

  // Memoize selected collection lookup for better performance
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
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between"
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
        <PopoverContent className="w-[300px] p-0">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search collections..."
              value={searchTerm}
              onValueChange={setSearchTerm}
            />
            <CommandList>
              <CommandEmpty>
                {isSearching ? (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 className="h-5 w-5 animate-spin mr-2" />
                    <span>Searching collections...</span>
                  </div>
                ) : (
                  "No collections found."
                )}
              </CommandEmpty>
              <CommandGroup>
                {displayedCollections.map((collection) => {
                  const isSelected = selectedCollectionsMap.has(collection.id);
                  return (
                    <CommandItem
                      key={collection.id}
                      value={collection.id}
                      onSelect={() => handleSelectCollection(collection)}
                    >
                      <div className="flex items-center justify-between w-full">
                        <div className="flex items-center gap-2 truncate">
                          <Check
                            className={cn(
                              "mr-2 h-4 w-4 shrink-0",
                              isSelected ? "opacity-100" : "opacity-0",
                            )}
                          />
                          <span className="truncate">{collection.name}</span>
                        </div>
                        {collection.type && (
                          <Badge
                            variant="outline"
                            className="ml-2 shrink-0 text-[10px] px-1.5 py-0"
                          >
                            {collection.type === "manual"
                              ? "Manual"
                              : "Dynamic"}
                          </Badge>
                        )}
                      </div>
                    </CommandItem>
                  );
                })}
              </CommandGroup>

              {currentPage < totalPages && (
                <div className="py-2 px-2 border-t">
                  <Button
                    variant="outline"
                    className="w-full"
                    size="sm"
                    onClick={loadMoreCollections}
                    disabled={isLoadingMore}
                  >
                    {isLoadingMore ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Loading...
                      </>
                    ) : (
                      <>
                        Load More ({displayedCollections.length} of{" "}
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

      {/* Show selected collections as badges */}
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
              {collection.type && (
                <Badge
                  variant="outline"
                  className="ml-1 text-[10px] px-1 py-0 border-muted-foreground/30"
                >
                  {collection.type === "manual" ? "M" : "D"}
                </Badge>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-4 w-4 p-0 ml-1"
                onClick={() => handleRemoveCollection(collection.id)}
              >
                <X className="h-3 w-3" />
                <span className="sr-only">Remove</span>
              </Button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
