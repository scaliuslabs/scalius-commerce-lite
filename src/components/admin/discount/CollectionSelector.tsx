//src/components/admin/discount/CollectionSelector.tsx
import { useState, useEffect, useRef } from "react";
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
import { Check, ChevronsUpDown, Folder, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "../../ui/badge";

// Collection interface
interface Collection {
  id: string;
  name: string;
  description: string | null;
  slug: string;
}

interface CollectionSelectorProps {
  selectedCollections: Collection[];
  onChange: (collections: Collection[]) => void;
  buttonLabel?: string;
  className?: string;
  isLoading?: boolean;
  maxItems?: number;
}

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
  const [collections, setCollections] = useState<Collection[]>([]);
  const [filteredCollections, setFilteredCollections] = useState<Collection[]>(
    [],
  );
  const [isSearching, setIsSearching] = useState(false);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load initial collections
  useEffect(() => {
    const fetchCollections = async () => {
      try {
        const response = await fetch("/api/collections?limit=50");
        const data = await response.json();
        // Handle both response formats: { data: [...] } from Astro API and { collections: [...] } from Hono API
        const collectionsArray = data.data || data.collections || [];
        if (collectionsArray.length > 0) {
          // Map to expected interface (ensure all required fields are present)
          const mappedCollections = collectionsArray.map((c: any) => ({
            id: c.id,
            name: c.name,
            description: c.description || null,
            slug: c.slug || "",
          }));
          setCollections(mappedCollections);
          setFilteredCollections(mappedCollections);
        }
      } catch (error) {
        console.error("Error fetching collections:", error);
      }
    };

    fetchCollections();
  }, []);

  // Handle search
  useEffect(() => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    if (!searchTerm.trim()) {
      setFilteredCollections(collections);
      return;
    }

    setIsSearching(true);

    // Debounce search to avoid too many API calls
    searchTimeoutRef.current = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/collections?search=${encodeURIComponent(searchTerm)}&limit=20`,
        );
        const data = await response.json();

        // Handle both response formats: { data: [...] } from Astro API and { collections: [...] } from Hono API
        const collectionsArray = data.data || data.collections || [];
        const mappedCollections = collectionsArray.map((c: any) => ({
          id: c.id,
          name: c.name,
          description: c.description || null,
          slug: c.slug || "",
        }));
        setFilteredCollections(mappedCollections);
      } catch (error) {
        console.error("Error searching collections:", error);
      } finally {
        setIsSearching(false);
      }
    }, 300);

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [searchTerm, collections]);

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

  return (
    <div className={className}>
      <Popover open={open} onOpenChange={setOpen}>
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
          <Command>
            <CommandInput
              placeholder="Search collections..."
              value={searchTerm}
              onValueChange={setSearchTerm}
            />
            <CommandList>
              <CommandEmpty>
                {isSearching ? "Searching..." : "No collections found."}
              </CommandEmpty>
              <CommandGroup>
                {filteredCollections.map((collection) => {
                  const isSelected = selectedCollections.some(
                    (c) => c.id === collection.id,
                  );
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
                              "mr-2 h-4 w-4",
                              isSelected ? "opacity-100" : "opacity-0",
                            )}
                          />
                          <span className="truncate">{collection.name}</span>
                        </div>
                      </div>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
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
              <span className="truncate max-w-[180px]">{collection.name}</span>
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
